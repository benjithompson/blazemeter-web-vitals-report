// Runs a REAL `npx playwright test` as a child process against fixture specs that import
// the library exactly as a tester would. This is Seam 1: we assert on the JSON files that
// land on disk, never on mocks and never on "attach was called" (worthless here — the
// whole point is that attach can be called correctly and still write nothing).
//
// Each run gets its own output dir. The child config (fixtures/playwright.config.ts)
// reads the fixture server URL and output dir from the env we pass here.

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sample } from '@bzm/vitals-format';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(HERE, '..', 'fixtures');

export interface RunOptions {
  /** Fixture spec filename under test/fixtures, e.g. "journey.spec.ts". */
  spec: string;
  baseURL: string;
  /** Project name from fixtures/playwright.config.ts. Defaults to "chromium". */
  project?: string;
  /** Extra CLI args, e.g. ['--repeat-each', '2', '--workers', '2']. */
  args?: string[];
  /** Extra env for the child (merged over process.env). */
  env?: Record<string, string>;
}

export interface RunResult {
  outputDir: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Run the fixture spec under a real Playwright run; returns the run's output dir. */
export async function runPlaywright(opts: RunOptions): Promise<RunResult> {
  const outputDir = await mkdtemp(join(tmpdir(), 'bzm-vitals-out-'));
  const args = [
    'playwright',
    'test',
    opts.spec,
    // Absolute --config so config resolution never depends on the child's cwd.
    '--config',
    join(FIXTURES_DIR, 'playwright.config.ts'),
    '--project',
    opts.project ?? 'chromium',
    '--output',
    outputDir,
    ...(opts.args ?? []),
  ];

  const child = spawn('npx', args, {
    cwd: FIXTURES_DIR,
    env: {
      ...process.env,
      PW_BASE_URL: opts.baseURL,
      PW_OUTPUT_DIR: outputDir,
      ...opts.env,
    },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });

  return { outputDir, exitCode, stdout, stderr };
}

/** Every file under a directory, recursively (absolute paths). */
export async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await recurse(full);
      else out.push(full);
    }
  }
  await recurse(dir);
  return out;
}

export interface FoundSample {
  path: string;
  sample: Sample;
}

/**
 * The original Sample files the two-step wrote to outputPath() — matched by exact name
 * `bzm-vitals-sample-<n>.json`. The attached copies carry a `-<sha1>` suffix and so are
 * excluded, which is deliberate: these files exist on disk independent of any reporter,
 * which is the property under test.
 */
export async function findSamples(outputDir: string): Promise<FoundSample[]> {
  const files = await walkFiles(outputDir);
  const originals = files.filter((f) => /\/bzm-vitals-sample-\d+\.json$/.test(f));
  const found: FoundSample[] = [];
  for (const path of originals) {
    const sample = JSON.parse(await readFile(path, 'utf8')) as Sample;
    found.push({ path, sample });
  }
  return found;
}

/** True if any file under the dir contains the given bytes (used for the token-leak check). */
export async function anyFileContains(dir: string, needle: string): Promise<boolean> {
  const files = await walkFiles(dir);
  const needleBuf = Buffer.from(needle, 'utf8');
  for (const f of files) {
    if ((await stat(f)).size === 0) continue;
    const buf = await readFile(f);
    if (buf.includes(needleBuf)) return true;
  }
  return false;
}
