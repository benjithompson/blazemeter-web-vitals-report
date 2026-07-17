#!/usr/bin/env node
// The CLI — the tracer bullet's trigger:
//
//   npx bzm-vitals-dashboard --master 82723459 --out report.html
//
// One command, one file, the data baked in. fetch → extract → adapt →
// attribute → aggregate crudely → embed → emit. Cache-through: artifacts land
// in the gitignored .artifact-cache, so a repeat run (or a run after the fetch
// script) does zero network calls — and needs no credentials at all.
//
// The bin entry is this thin wrapper; tests invoke runCli in-process with a
// stubbed Transport and never touch the network.

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCredentials, type Credentials, type Transport } from './http.js';
import { cacheMaster, defaultCacheRoot } from './cache.js';
import { buildReportData } from './report.js';
import { renderHtml } from './render.js';

const USAGE = 'usage: bzm-vitals-dashboard --master <masterId> --out <report.html>';

export interface RunCliOptions {
  /** Arguments after the program name, e.g. ['--master', '82723459', '--out', 'r.html']. */
  argv: string[];
  env?: NodeJS.ProcessEnv;
  /** Injected by tests; the real run uses global fetch. */
  transport?: Transport;
  /** Defaults to <repo-root>/.artifact-cache. */
  cacheRoot?: string;
  /** Progress messages. Defaults to stderr; the HTML goes to --out, never stdout. */
  log?: (message: string) => void;
}

interface CliArgs {
  masterId: string;
  outPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  let masterId: string | undefined;
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--master') masterId = argv[++i];
    else if (arg === '--out') outPath = argv[++i];
    else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  if (!masterId || !outPath) throw new Error(USAGE);
  return { masterId, outPath };
}

export async function runCli(opts: RunCliOptions): Promise<{ outPath: string }> {
  const { masterId, outPath } = parseArgs(opts.argv);
  const cacheRoot = opts.cacheRoot ?? defaultCacheRoot();
  const log = opts.log ?? ((message: string) => console.error(message));

  const masterDir = path.join(cacheRoot, masterId);
  const cached = existsSync(path.join(masterDir, 'manifest.json'));

  // Credentials authenticate only the listing calls, so a fully cached master
  // needs none — the warm path must work offline.
  let creds: Credentials = { id: '', secret: '' };
  if (!cached) {
    creds = await loadCredentials(opts.env ?? process.env);
    log(`fetching Report ${masterId} — an archived Report may take a moment (latency, not failure)`);
  }

  const manifest = await cacheMaster(masterId, {
    creds,
    transport: opts.transport,
    cacheRoot,
  });

  const data = await buildReportData(manifest, masterDir);
  await writeFile(outPath, renderHtml(data), 'utf8');

  const unreadable = data.sessions.reduce((n, s) => n + s.unreadable.length, 0);
  log(
    `wrote ${outPath} — ${data.samples.length} Samples across ` +
      `${data.sessions.length} Engine(s), ${data.routes.length} Route(s)` +
      (unreadable > 0 ? `, ${unreadable} unreadable record(s)` : ''),
  );
  return { outPath };
}

// Thin executable wrapper — everything above is invocable in-process.
const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  runCli({ argv: process.argv.slice(2) }).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
