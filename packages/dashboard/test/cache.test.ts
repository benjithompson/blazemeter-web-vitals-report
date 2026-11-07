import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, rm, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SAMPLE_ATTACHMENT_PREFIX as S } from 'bzm-vitals-format';
import { cacheMaster, cacheMasterRecords, defaultCacheRoot, type CachedMaster } from '../src/cache.js';
import { createTransport } from '../src/http.js';
import { runCli } from '../src/cli.js';
import { jsonResponse, bytesResponse, recordingTransport } from './helpers/transport.js';
import { makeZip } from './helpers/zip.js';
import type { Credentials } from '../src/http.js';

const creds: Credentials = { id: 'k', secret: 's' };

/** The text of one Engine's record `${S}-${name}`, as the cache read it in memory. */
async function recordText(cached: CachedMaster, sessionId: string, name: string): Promise<string> {
  const engine = cached.engines.find((e) => e.sessionId === sessionId);
  const file = engine?.files.find((f) => f.file === `${S}-${name}`);
  if (!file) throw new Error(`no record ${name} for ${sessionId}`);
  return file.read();
}
const STATUS_RE = /\/masters\/([^/]+)\/status$/;
const LOGS_RE = /\/sessions\/([^/]+)\/reports\/logs$/;

// Two Engines: aaa has an artifact, bbb died and emitted none.
function twoEngineHandler(zipA: Buffer) {
  return (url: string) => {
    // GET /masters/{id} (no /status) → the Report object, fetched cold.
    if (/\/masters\/[^/]+$/.test(url)) {
      return jsonResponse({ result: { name: 'Two-Engine run' } });
    }
    if (STATUS_RE.test(url)) {
      return jsonResponse({
        result: {
          sessions: [
            { id: 'r-v4-aaa', status: 'ENDED', locationId: 'us-west-1' },
            { id: 'r-v4-bbb', status: 'ENDED', locationId: 'us-west-2' },
          ],
        },
      });
    }
    if (/\/sessions\/r-v4-aaa\/reports\/logs$/.test(url)) {
      return jsonResponse({
        result: { data: [{ filename: 'artifacts.zip', dataUrl: 'https://storage/aaa?sig=1' }] },
      });
    }
    if (/\/sessions\/r-v4-bbb\/reports\/logs$/.test(url)) {
      return jsonResponse({ result: { data: [{ filename: 'bzt.log', dataUrl: 'x' }] } });
    }
    if (url.startsWith('https://storage/aaa')) return bytesResponse(zipA);
    throw new Error(`unexpected ${url}`);
  };
}

let cacheRoot: string;
beforeEach(async () => {
  cacheRoot = await mkdtemp(path.join(tmpdir(), 'bzm-cache-'));
});
afterEach(async () => {
  await rm(cacheRoot, { recursive: true, force: true });
});

describe('cacheMaster', () => {
  it('enumerates sessions, reads records namespaced by sessionId, records the no-artifact Engine', async () => {
    const zipA = makeZip([
      { name: `${S}-repeat0.json`, data: Buffer.from('a0') },
      { name: `${S}-repeat18.json`, data: Buffer.from('a18') },
      { name: 'bzt.log', data: Buffer.from('not a record') },
    ]);
    const { transport } = recordingTransport(twoEngineHandler(zipA));

    const cached = await cacheMasterRecords('82724289', { creds, transport, cacheRoot });
    const { manifest } = cached;

    expect(manifest.sessions).toHaveLength(2);
    const aaa = manifest.sessions.find((s) => s.sessionId === 'r-v4-aaa')!;
    const bbb = manifest.sessions.find((s) => s.sessionId === 'r-v4-bbb')!;
    expect(aaa.artifact).toBe('present');
    expect(aaa.fileCount).toBe(3);
    expect(bbb.artifact).toBe('no-artifact');

    // Records read in memory, under their own Engine; only records.
    expect(cached.engines.map((e) => [e.sessionId, e.files.map((f) => f.file)])).toEqual([
      ['r-v4-aaa', [`${S}-repeat0.json`, `${S}-repeat18.json`]],
      ['r-v4-bbb', []],
    ]);
    expect(await recordText(cached, 'r-v4-aaa', 'repeat18.json')).toBe('a18');
    // Raw zip bytes cached, and nothing extracted beside them.
    const masterDir = path.join(cacheRoot, '82724289');
    expect((await readdir(masterDir)).sort()).toEqual(['manifest.json', 'r-v4-aaa.zip']);
  });

  it('does no network calls on a second run against a cached master', async () => {
    const zipA = makeZip([{ name: `${S}-repeat0.json`, data: Buffer.from('a0') }]);
    const first = recordingTransport(twoEngineHandler(zipA));
    await cacheMaster('82724289', { creds, transport: first.transport, cacheRoot });
    expect(first.calls.length).toBeGreaterThan(0);

    // Second run: a transport that throws if touched.
    const second = recordingTransport(() => {
      throw new Error('network call on a cached master');
    });
    const cached = await cacheMasterRecords('82724289', {
      creds,
      transport: second.transport,
      cacheRoot,
    });
    expect(second.calls).toHaveLength(0);
    expect(cached.manifest.sessions).toHaveLength(2);
    // The records still come from the cached zip.
    expect(await recordText(cached, 'r-v4-aaa', 'repeat0.json')).toBe('a0');
  });

  it('removes the extracted session dirs a pre-D5 cache left beside its zips', async () => {
    const zipA = makeZip([{ name: `${S}-repeat0.json`, data: Buffer.from('a0') }]);
    await cacheMaster('82724289', { creds, transport: recordingTransport(twoEngineHandler(zipA)).transport, cacheRoot });
    const legacy = path.join(cacheRoot, '82724289', 'r-v4-aaa');
    await mkdir(legacy);
    await writeFile(path.join(legacy, `${S}-repeat0.json`), 'a0');

    await cacheMaster('82724289', { creds, transport: offline().transport, cacheRoot });
    expect(existsSync(legacy)).toBe(false);
  });
});

// ------------------------------------------- the cache against a fake API

const MASTER_RE = /\/masters\/[^/]+$/;

/** One session as the fake API reports it; `zip` null = no artifacts.zip (yet). */
interface FakeSession {
  id: string;
  status: string;
  zip: Buffer | null;
}

/** A stub BlazeMeter whose master status and sessions a test can change between runs. */
function fakeBlazemeter(state: { masterStatus: string; sessions: FakeSession[] }) {
  return (url: string) => {
    if (MASTER_RE.test(url)) return jsonResponse({ result: { name: 'D1 run' } });
    if (STATUS_RE.test(url)) {
      return jsonResponse({
        result: {
          status: state.masterStatus,
          sessions: state.sessions.map((s) => ({ id: s.id, status: s.status, locationId: 'us-east-1' })),
        },
      });
    }
    const logs = LOGS_RE.exec(url);
    if (logs) {
      const s = state.sessions.find((x) => x.id === logs[1]);
      const data = s?.zip ? [{ filename: 'artifacts.zip', dataUrl: `https://storage/${s.id}?sig=1` }] : [];
      return jsonResponse({ result: { data } });
    }
    const dl = /^https:\/\/storage\/([^?]+)/.exec(url);
    if (dl) {
      const s = state.sessions.find((x) => x.id === dl[1]);
      if (s?.zip) return bytesResponse(s.zip);
    }
    throw new Error(`unexpected ${url}`);
  };
}

const zipOf = (name: string, text: string) => makeZip([{ name: `${S}-${name}`, data: Buffer.from(text) }]);
const offline = () =>
  recordingTransport(() => {
    throw new Error('network call on a cached master');
  });

describe('D1: the cache root', () => {
  it('a module path containing a space never yields a %20 cache root', async () => {
    // Load a copy of the dashboard sources from a directory whose path has a
    // space (and a packages/ segment, which the old walk-up keyed on), so the
    // module's own URL is file:///…/with%20space/packages/dashboard/src/cache.ts.
    const srcDir = path.join(cacheRoot, 'with space', 'packages', 'dashboard', 'src');
    await mkdir(srcDir, { recursive: true });
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const f of await readdir(path.join(here, '../src'))) {
      if (f.endsWith('.ts')) await copyFile(path.join(here, '../src', f), path.join(srcDir, f));
    }
    // The copy's one package dependency, resolvable from beside it (cache.ts
    // reads zips through local.ts, which imports the format package).
    const modules = path.join(cacheRoot, 'with space', 'node_modules');
    await mkdir(modules, { recursive: true });
    await symlink(path.resolve(here, '../../format'), path.join(modules, 'bzm-vitals-format'), 'dir');
    const moduleUrl = pathToFileURL(path.join(srcDir, 'cache.ts')).href;
    expect(moduleUrl).toContain('with%20space');
    vi.stubEnv('BZM_VITALS_CACHE_DIR', '');
    try {
      const copy = (await import(moduleUrl)) as typeof import('../src/cache.js');
      const root = copy.defaultCacheRoot();
      expect(root).not.toContain('%20');
      expect(root).toBe(path.resolve(process.cwd(), '.artifact-cache'));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('is --cache-dir, else $BZM_VITALS_CACHE_DIR, else ./.artifact-cache under the cwd', async () => {
    const resolve = defaultCacheRoot;
    const cwd = '/work/my reports';
    expect(resolve({ env: {}, cwd })).toBe('/work/my reports/.artifact-cache');
    expect(resolve({ env: {}, cwd, cacheDir: 'cache dir' })).toBe('/work/my reports/cache dir');
    expect(resolve({ env: { BZM_VITALS_CACHE_DIR: '/srv/bzm cache' }, cwd })).toBe('/srv/bzm cache');
    // The flag wins over the env var.
    expect(resolve({ env: { BZM_VITALS_CACHE_DIR: '/srv/bzm cache' }, cwd, cacheDir: 'x' })).toBe(
      '/work/my reports/x',
    );
    expect(resolve({ env: { BZM_VITALS_CACHE_DIR: '  ' }, cwd })).toBe('/work/my reports/.artifact-cache');
  });
});

describe('D1: invalidation', () => {
  it('a master cached while RUNNING is refreshed next run, fetching only the missing/changed sessions', async () => {
    const state = {
      masterStatus: 'RUNNING',
      sessions: [
        { id: 'r-v4-done', status: 'ENDED', zip: zipOf('a.json', 'done') },
        { id: 'r-v4-busy', status: 'RUNNING', zip: null as Buffer | null },
      ],
    };
    const first = recordingTransport(fakeBlazemeter(state));
    const m1 = await cacheMaster('700', { creds, transport: first.transport, cacheRoot });
    expect(m1.sessions.find((s) => s.sessionId === 'r-v4-busy')!.artifact).toBe('no-artifact');

    // The run finishes; the busy Engine now has its artifact.
    state.masterStatus = 'ENDED';
    state.sessions[1] = { id: 'r-v4-busy', status: 'ENDED', zip: zipOf('b.json', 'busy') };
    const second = recordingTransport(fakeBlazemeter(state));
    const c2 = await cacheMasterRecords('700', { creds, transport: second.transport, cacheRoot });
    const m2 = c2.manifest;

    expect(second.calls.some((u) => STATUS_RE.test(u))).toBe(true);
    const busy = m2.sessions.find((s) => s.sessionId === 'r-v4-busy')!;
    expect(busy.artifact).toBe('present');
    expect(await recordText(c2, 'r-v4-busy', 'b.json')).toBe('busy');
    // The unchanged, already-ENDED session is not fetched again.
    expect(second.calls.filter((u) => u.includes('r-v4-done'))).toEqual([]);

    // Now ENDED in the manifest: the third run makes no network call at all.
    const third = offline();
    await cacheMaster('700', { creds, transport: third.transport, cacheRoot });
    expect(third.calls).toEqual([]);
  });

  it('a master cached when ENDED makes no network call, and needs no credentials', async () => {
    const state = { masterStatus: 'ENDED', sessions: [{ id: 'r-v4-a', status: 'ENDED', zip: zipOf('a.json', 'a') }] };
    await cacheMaster('701', { creds, transport: recordingTransport(fakeBlazemeter(state)).transport, cacheRoot });
    const raw = JSON.parse(await readFile(path.join(cacheRoot, '701', 'manifest.json'), 'utf8'));
    expect(raw.masterStatus).toBe('ENDED');

    const second = offline();
    const noCreds = async () => {
      throw new Error('credentials loaded for a cached master');
    };
    await cacheMaster('701', { creds: noCreds, transport: second.transport, cacheRoot });
    expect(second.calls).toEqual([]);
  });

  it('refresh ignores the manifest and fetches again', async () => {
    const state = { masterStatus: 'ENDED', sessions: [{ id: 'r-v4-a', status: 'ENDED', zip: zipOf('a.json', 'v1') }] };
    await cacheMaster('702', { creds, transport: recordingTransport(fakeBlazemeter(state)).transport, cacheRoot });
    state.sessions[0]!.zip = zipOf('a.json', 'v2');
    const again = recordingTransport(fakeBlazemeter(state));
    const c = await cacheMasterRecords('702', { creds, transport: again.transport, cacheRoot, refresh: true });
    expect(again.calls.some((u) => u.startsWith('https://storage/r-v4-a'))).toBe(true);
    expect(await recordText(c, 'r-v4-a', 'a.json')).toBe('v2');
  });
});

describe('D1: atomic writes', () => {
  it('debris from a run killed mid-download is never trusted: truncated zip deleted and refetched, with a warning', async () => {
    const zip = zipOf('a.json', 'whole');
    const masterDir = path.join(cacheRoot, '703');
    await mkdir(masterDir, { recursive: true });
    // What a kill can leave: a half-written zip under its final name (the old
    // non-atomic write), a half-written temp zip, and a half-written manifest.
    await writeFile(path.join(masterDir, 'r-v4-a.zip'), zip.subarray(0, zip.length >> 1));
    await writeFile(path.join(masterDir, 'r-v4-b.zip.tmp'), zip.subarray(0, 10));
    await writeFile(path.join(masterDir, 'manifest.json.tmp'), '{"masterId": "70');

    const state = {
      masterStatus: 'ENDED',
      sessions: [
        { id: 'r-v4-a', status: 'ENDED', zip },
        { id: 'r-v4-b', status: 'ENDED', zip },
      ],
    };
    const warnings: string[] = [];
    const run = recordingTransport(fakeBlazemeter(state));
    const c = await cacheMasterRecords('703', { creds, transport: run.transport, cacheRoot, log: (m: string) => warnings.push(m) });

    expect(run.calls.some((u) => u.startsWith('https://storage/r-v4-a'))).toBe(true);
    expect(warnings.join('\n')).toMatch(/r-v4-a.*(truncated|corrupt)/);
    expect(await recordText(c, 'r-v4-a', 'a.json')).toBe('whole');
    expect((await readdir(masterDir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a truncated zip under a trusted manifest is deleted and refetched, with a warning', async () => {
    const zip = zipOf('a.json', 'whole');
    const state = { masterStatus: 'ENDED', sessions: [{ id: 'r-v4-a', status: 'ENDED', zip }] };
    await cacheMaster('704', { creds, transport: recordingTransport(fakeBlazemeter(state)).transport, cacheRoot });
    const zipPath = path.join(cacheRoot, '704', 'r-v4-a.zip');
    await writeFile(zipPath, zip.subarray(0, zip.length - 30));

    const warnings: string[] = [];
    const run = recordingTransport(fakeBlazemeter(state));
    await cacheMaster('704', { creds, transport: run.transport, cacheRoot, log: (m: string) => warnings.push(m) });
    expect(warnings.join('\n')).toMatch(/r-v4-a/);
    expect(run.calls.filter((u) => u.startsWith('https://storage/'))).toEqual(['https://storage/r-v4-a?sig=1']);
    expect(await readFile(zipPath)).toEqual(zip);
  });

  it('a download that fails part-way leaves no manifest and no zip for that session', async () => {
    const zip = zipOf('a.json', 'whole');
    const state = {
      masterStatus: 'ENDED',
      sessions: [
        { id: 'r-v4-a', status: 'ENDED', zip },
        { id: 'r-v4-b', status: 'ENDED', zip },
      ],
    };
    const base = fakeBlazemeter(state);
    const { transport } = recordingTransport((url) =>
      url.startsWith('https://storage/r-v4-b') ? bytesResponse(Buffer.alloc(0), 500) : base(url),
    );
    await expect(cacheMaster('705', { creds, transport, cacheRoot })).rejects.toThrow(/r-v4-b/);
    const files = await readdir(path.join(cacheRoot, '705'));
    expect(files).not.toContain('manifest.json');
    expect(files).not.toContain('r-v4-b.zip');
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('D1: parallel downloads', () => {
  it('8 sessions against a fake server: at most 4 downloads in flight, and more than 1', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `r-v4-p${i}`);
    const zip = zipOf('a.json', 'p');
    let inFlight = 0;
    let peak = 0;
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      const send = (body: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.startsWith('/dl/')) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        setTimeout(() => {
          inFlight--;
          res.writeHead(200, { 'content-type': 'application/zip' });
          res.end(zip);
        }, 60);
        return;
      }
      if (url.endsWith('/status')) {
        return send({ result: { status: 'ENDED', sessions: ids.map((id) => ({ id, status: 'ENDED', locationId: 'l' })) } });
      }
      const logs = /\/sessions\/([^/]+)\/reports\/logs$/.exec(url);
      if (logs) {
        const dataUrl = `http://${req.headers.host}/dl/${logs[1]}?sig=1`;
        return send({ result: { data: [{ filename: 'artifacts.zip', dataUrl }] } });
      }
      return send({ result: { name: 'parallel' } });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // D3's real retrying transport, over real sockets.
      const manifest = await cacheMaster('706', {
        creds,
        transport: createTransport(),
        apiBase: `http://127.0.0.1:${port}`,
        cacheRoot,
      });
      expect(manifest.sessions.filter((s) => s.artifact === 'present')).toHaveLength(8);
      expect(peak).toBe(4);
      expect(peak).toBeGreaterThan(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('D1: the CLI flags', () => {
  const ENV = { BLAZEMETER_API_KEY_ID: 'stub-id', BLAZEMETER_API_KEY_SECRET: 'stub-secret' };
  const ended = () => ({
    masterStatus: 'ENDED',
    sessions: [{ id: 'r-v4-a', status: 'ENDED', zip: zipOf('a.json', 'a') as Buffer | null }],
  });

  it('--cache-dir chooses the cache and overrides BZM_VITALS_CACHE_DIR, which applies without it', async () => {
    const out = path.join(cacheRoot, 'r.html');
    const flagDir = path.join(cacheRoot, 'flag dir');
    const envDir = path.join(cacheRoot, 'env dir');
    const t = () => recordingTransport(fakeBlazemeter(ended())).transport;
    await runCli({ argv: ['--master', '710', '--out', out, '--cache-dir', flagDir], env: ENV, transport: t(), log: () => {} });
    expect(existsSync(path.join(flagDir, '710', 'manifest.json'))).toBe(true);

    await runCli({
      argv: ['--master', '711', '--out', out, '--cache-dir', flagDir],
      env: { ...ENV, BZM_VITALS_CACHE_DIR: envDir },
      transport: t(),
      log: () => {},
    });
    expect(existsSync(path.join(flagDir, '711', 'manifest.json'))).toBe(true);
    expect(existsSync(path.join(envDir, '711'))).toBe(false);

    await runCli({
      argv: ['--master', '712', '--out', out],
      env: { ...ENV, BZM_VITALS_CACHE_DIR: envDir },
      transport: t(),
      log: () => {},
    });
    expect(existsSync(path.join(envDir, '712', 'manifest.json'))).toBe(true);
  });

  it('--refresh refetches a finished, cached master; without it the rerun is offline', async () => {
    const out = path.join(cacheRoot, 'r.html');
    const argv = ['--master', '712', '--out', out];
    await runCli({ argv, env: ENV, transport: recordingTransport(fakeBlazemeter(ended())).transport, cacheRoot, log: () => {} });

    const warm = offline();
    await runCli({ argv, env: {}, transport: warm.transport, cacheRoot, log: () => {} });
    expect(warm.calls).toEqual([]);

    const refreshed = recordingTransport(fakeBlazemeter(ended()));
    await runCli({ argv: [...argv, '--refresh'], env: ENV, transport: refreshed.transport, cacheRoot, log: () => {} });
    expect(refreshed.calls.some((u) => u.startsWith('https://storage/r-v4-a'))).toBe(true);
  });

  it("runCli reads BLAZEMETER_API_BASE from its own env", async () => {
    const run = recordingTransport(fakeBlazemeter(ended()));
    await runCli({
      argv: ['--master', '713', '--out', path.join(cacheRoot, 'r.html')],
      env: { ...ENV, BLAZEMETER_API_BASE: 'https://bzm.example.test/' },
      transport: run.transport,
      cacheRoot,
      log: () => {},
    });
    expect(run.calls[0]).toBe('https://bzm.example.test/api/v4/masters/713');
  });

  it('--help lists the cache flags and every environment variable', async () => {
    let text = '';
    await runCli({ argv: ['--help'], env: {}, print: (t) => (text = t) });
    for (const needle of ['--cache-dir <dir>', '--refresh', 'BLAZEMETER_API_BASE', 'BZM_VITALS_CACHE_DIR']) {
      expect(text).toContain(needle);
    }
  });
});
