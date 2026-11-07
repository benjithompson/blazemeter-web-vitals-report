#!/usr/bin/env node
// The CLI — the tracer bullet's trigger:
//
//   npx bzm-vitals-dashboard --master 82723459 --out report.html
//
// One command, one file, the data baked in. fetch → read in memory → adapt →
// attribute → aggregate crudely → embed → emit. Cache-through: artifacts land
// in the gitignored .artifact-cache, so a repeat run (or a run after the fetch
// script) does zero network calls — and needs no credentials at all. A master
// cached before it had ENDED is re-listed next run, fetching only what changed.
//
// Offline alternative: --artifacts <path> reads downloaded artifacts (a zip, an
// unzipped folder, or a folder of either) and never touches the network or the
// cache. --master is then optional and only names the Report.
//
// The bin entry is this thin wrapper; tests invoke runCli in-process with a
// stubbed Transport and never touch the network.

import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadCredentials, type Transport } from './http.js';
import { resolveApiBase } from './api.js';
import { cacheMasterRecords, defaultCacheRoot } from './cache.js';
import { extractNamespaced } from './extract.js';
import { assembleReportData, buildReportData, type ReportData } from './report.js';
import { readLocalArtifacts } from './local.js';
import { renderHtml } from './render.js';

/** This package's version, printed by --version. A plain constant rather than a
 *  runtime read of package.json, so the one-file standalone builds (which ship
 *  with no package.json beside them) carry it inlined with no bundler support.
 *  test/cli-args.test.ts fails if it ever drifts from package.json. */
export const DASHBOARD_VERSION = '0.4.0';

const PROGRAM = 'bzm-vitals-dashboard';

const USAGE =
  `usage: ${PROGRAM} --master <masterId> --out <report.html>\n` +
  `       ${PROGRAM} --artifacts <zip-or-folder> [--master <masterId>] --out <report.html>`;

const HELP = [
  `${PROGRAM} ${DASHBOARD_VERSION} — turn a BlazeMeter Playwright run into one self-contained report.html`,
  '',
  USAGE,
  `       ${PROGRAM} --help | --version`,
  '',
  'Input modes:',
  '  --master <masterId>         Fetch the Report from the BlazeMeter API and cache its',
  '                              artifacts in the cache; a master cached after it ENDED',
  '                              re-runs with no network and no credentials.',
  '  --artifacts <zip-or-folder> Read downloaded artifacts instead (one artifacts.zip,',
  '                              its unzipped folder, or a folder of either). No network,',
  '                              no credentials, no cache. --master then only names the Report.',
  '',
  'Options:',
  '  --out <report.html>         Where to write the report (required).',
  '  --cache-dir <dir>           Cache directory (API mode); overrides BZM_VITALS_CACHE_DIR.',
  '                              Default ./.artifact-cache under the current directory.',
  '  --refresh                   Ignore the cache for this master and fetch it again.',
  '  --extract <dir>             Debugging (API mode): also unzip each Engine\'s cached',
  '                              artifacts into <dir>/{sessionId}/. The report never needs it.',
  '  -h, --help                  Print this help and exit.',
  '  --version                   Print the version and exit.',
  '',
  'Environment (API mode only):',
  '  BLAZEMETER_API_KEY          Path to an api-key.json holding {"id", "secret"}.',
  '  BLAZEMETER_API_KEY_ID       Key id and secret as discrete variables (CI);',
  '  BLAZEMETER_API_KEY_SECRET   used when BLAZEMETER_API_KEY is unset.',
  '  BLAZEMETER_API_BASE         API host; default https://a.blazemeter.com.',
  '  BZM_VITALS_CACHE_DIR        Cache directory, when --cache-dir is not given.',
].join('\n');

/** A command-line mistake: the bin prints `message` alone (no stack) and exits
 *  with `exitCode` — 2 for a malformed command line (unknown flag, missing or
 *  empty value, stray positional), 1 when no command was given (no --out, or
 *  no input), as before. */
export class CliUsageError extends Error {
  readonly exitCode: 1 | 2;
  constructor(message: string, exitCode: 1 | 2) {
    super(message);
    this.name = 'CliUsageError';
    this.exitCode = exitCode;
  }
}

export interface RunCliOptions {
  /** Arguments after the program name, e.g. ['--master', '82723459', '--out', 'r.html']. */
  argv: string[];
  env?: NodeJS.ProcessEnv;
  /** Injected by tests; the real run uses global fetch. */
  transport?: Transport;
  /** Injected by tests; overrides --cache-dir and BZM_VITALS_CACHE_DIR. */
  cacheRoot?: string;
  /** Progress messages. Defaults to stderr; the HTML goes to --out, never stdout. */
  log?: (message: string) => void;
  /** Where --help and --version print. Defaults to stdout. */
  print?: (text: string) => void;
}

export type CliArgs =
  | { source: 'help' }
  | { source: 'version' }
  | {
      source: 'api';
      masterId: string;
      outPath: string;
      cacheDir?: string;
      refresh?: true;
      extractDir?: string;
    }
  | { source: 'local'; artifactsPath: string; masterId: string | null; outPath: string };

/** The whole flag table; each flag also gets a line in HELP. */
const CLI_OPTIONS = {
  master: { type: 'string' },
  artifacts: { type: 'string' },
  out: { type: 'string' },
  'cache-dir': { type: 'string' },
  refresh: { type: 'boolean' },
  extract: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
} as const satisfies ParseArgsConfig['options'];

function malformed(problem: string): CliUsageError {
  return new CliUsageError(`${PROGRAM}: ${problem}\nRun '${PROGRAM} --help' for usage.`, 2);
}

/** The first problem in argv, in our own words. node:util's strict-mode
 *  messages run to several sentences and differ between Node releases, so the
 *  command line is first walked as tokens (non-strict, which never throws). */
function firstProblem(argv: string[]): string | null {
  const { tokens } = parseArgs({ args: argv, options: CLI_OPTIONS, strict: false, tokens: true });
  for (const token of tokens) {
    if (token.kind === 'positional') return `unexpected argument '${token.value}'`;
    if (token.kind !== 'option') continue;
    const spec = Object.hasOwn(CLI_OPTIONS, token.name)
      ? CLI_OPTIONS[token.name as keyof typeof CLI_OPTIONS]
      : undefined;
    if (spec === undefined) return `unknown option '${token.rawName}'`;
    if (spec.type === 'boolean') {
      if (token.value !== undefined) return `option '${token.rawName}' takes no value`;
      continue;
    }
    // A string option: no value at all, a value that is really the next flag
    // (`--master --out r.html`), or an empty `--master=`.
    if (token.value === undefined || (!token.inlineValue && token.value.startsWith('-'))) {
      return `option '--${token.name}' needs a value`;
    }
    if (token.value === '') return `option '--${token.name}' needs a non-empty value`;
  }
  return null;
}

/** Parse argv strictly. Throws CliUsageError; never returns a half-parsed command. */
export function parseCliArgs(argv: string[]): CliArgs {
  const problem = firstProblem(argv);
  if (problem !== null) throw malformed(problem);
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: CLI_OPTIONS, strict: true, allowPositionals: false }));
  } catch (err) {
    // Unreachable while firstProblem mirrors the strict rules; if a Node
    // release adds one, its own first sentence still names the problem.
    const message = err instanceof Error ? err.message : String(err);
    throw malformed(message.split(/\.(?:\s|$)/)[0]!.trim());
  }

  if (values.help) return { source: 'help' };
  if (values.version) return { source: 'version' };
  const { master: masterId, artifacts: artifactsPath, out: outPath } = values;

  if (outPath === undefined) throw new CliUsageError(USAGE, 1);
  if (artifactsPath !== undefined) {
    if (values.extract !== undefined) {
      throw malformed(`option '--extract' applies to --master only; --artifacts input is already on disk`);
    }
    return { source: 'local', artifactsPath, masterId: masterId ?? null, outPath };
  }
  if (masterId === undefined) throw new CliUsageError(USAGE, 1);
  // Optional fields only when given, so a plain command parses as before.
  return {
    source: 'api',
    masterId,
    outPath,
    ...(values['cache-dir'] !== undefined && { cacheDir: values['cache-dir'] }),
    ...(values.refresh && { refresh: true as const }),
    ...(values.extract !== undefined && { extractDir: values.extract }),
  };
}

/** Run one command. `outPath` is null for --help / --version, which write
 *  nothing but their text. */
export async function runCli(opts: RunCliOptions): Promise<{ outPath: string | null }> {
  const args = parseCliArgs(opts.argv);
  if (args.source === 'help' || args.source === 'version') {
    const print = opts.print ?? ((text: string) => void process.stdout.write(`${text}\n`));
    print(args.source === 'help' ? HELP : DASHBOARD_VERSION);
    return { outPath: null };
  }
  const log = opts.log ?? ((message: string) => console.error(message));

  const data =
    args.source === 'local'
      ? await buildFromLocal(args.artifactsPath, args.masterId, log)
      : await buildFromApi(args, opts, log);
  const { outPath } = args;
  await writeFile(outPath, renderHtml(data), 'utf8');

  const unreadable = data.sessions.reduce((n, s) => n + s.unreadable.length, 0);
  log(
    `wrote ${outPath} — ${data.samples.length} Samples across ` +
      `${data.sessions.length} Engine(s), ${data.routes.length} Route(s)` +
      (unreadable > 0 ? `, ${unreadable} unreadable record(s)` : ''),
  );
  return { outPath };
}

/** Local artifacts — no credentials, no network, no cache writes. */
async function buildFromLocal(
  artifactsPath: string,
  masterId: string | null,
  log: (message: string) => void,
): Promise<ReportData> {
  log(`reading artifacts from ${artifactsPath} — no network`);
  const engines = await readLocalArtifacts(artifactsPath);
  return assembleReportData({
    masterId,
    reportName: null,
    localSource: path.basename(path.resolve(artifactsPath)),
    engines,
  });
}

async function buildFromApi(
  args: Extract<CliArgs, { source: 'api' }>,
  opts: RunCliOptions,
  log: (message: string) => void,
): Promise<ReportData> {
  const { masterId } = args;
  const env = opts.env ?? process.env;
  const cacheRoot = opts.cacheRoot ?? defaultCacheRoot({ env, cacheDir: args.cacheDir });
  const apiBase = resolveApiBase(env);

  // Credentials authenticate only the listing calls, so they are loaded only
  // if the network is needed: a finished, cached master runs offline.
  const cached = await cacheMasterRecords(masterId, {
    creds: async () => {
      const creds = await loadCredentials(env);
      log(`fetching Report ${masterId} — an archived Report may take a moment (latency, not failure)`);
      return creds;
    },
    transport: opts.transport,
    apiBase,
    cacheRoot,
    refresh: args.refresh,
    log,
  });

  if (args.extractDir !== undefined) {
    // Debugging only: the report above never touched these files on disk.
    const masterDir = path.join(cacheRoot, masterId);
    for (const s of cached.manifest.sessions) {
      if (s.artifact !== 'present' || !s.zipPath) continue;
      const { sessionDir } = await extractNamespaced(
        await readFile(path.join(masterDir, s.zipPath)),
        s.sessionId,
        args.extractDir,
      );
      log(`extracted ${s.sessionId} to ${sessionDir}`);
    }
  }

  return buildReportData(cached);
}

// Thin executable wrapper — everything above is invocable in-process.
//
// npm installs the bin as a SYMLINK (node_modules/.bin/… -> dist/cli.js), so
// process.argv[1] is the symlink path while import.meta.url is realpath-
// resolved. Comparing them raw never matches through the installed bin, and the
// CLI would silently no-op. Realpath-resolve argv[1] first;
// fall back to the raw compare if it can't be resolved. Pure and exported so the
// resolution logic is unit-tested without spawning a process (test/cli-entry).
export function isEntryPoint(
  metaUrl: string,
  argv1: string | undefined,
  realpath: (p: string) => string = realpathSync,
): boolean {
  if (typeof argv1 !== 'string') return false;
  try {
    if (metaUrl === pathToFileURL(realpath(argv1)).href) return true;
  } catch {
    // argv1 isn't a resolvable path (unusual loader) — fall through.
  }
  return metaUrl === pathToFileURL(argv1).href;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  runCli({ argv: process.argv.slice(2) }).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(err instanceof CliUsageError ? err.exitCode : 1);
  });
}
