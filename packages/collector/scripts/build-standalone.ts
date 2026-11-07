#!/usr/bin/env tsx
// Builds dist-standalone/bzm-playwright-vitals.ts: the ONE-FILE collector a tester uploads to a
// BlazeMeter test next to a spec that does `import { test, expect } from './bzm-playwright-vitals'`.
//
// esbuild bundles src/index.ts with bzm-vitals-format inlined from its SOURCE (never a stale
// dist/), on every run. The output is plain ESM JavaScript in a .ts file (// @ts-nocheck), which
// Playwright's own TS loader transpiles on the Engine like any relative TS import. The build FAILS
// if the bundle imports anything an Engine lacks: only node:* builtins and @playwright/test may
// stay external. The artifact is gitignored; Seam 1 (test/standalone.test.ts) rebuilds it first.

import { build, type Plugin } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const COLLECTOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORMAT_SRC = join(COLLECTOR_DIR, '..', 'format', 'src', 'index.ts');
const OUT_FILE = join(COLLECTOR_DIR, 'dist-standalone', 'bzm-playwright-vitals.ts');
const UPLOAD_KIT_COPY = join(COLLECTOR_DIR, 'upload-kit', 'bzm-playwright-vitals.ts');

/** Resolve the workspace format package to its source file, so the bundle can never lag it. */
const formatFromSource: Plugin = {
  name: 'bzm-vitals-format-from-source',
  setup: (b) => void b.onResolve({ filter: /^bzm-vitals-format$/ }, () => ({ path: FORMAT_SRC })),
};

/** Bundle `entry` to ESM JavaScript; throws if any import but node:* or @playwright/test survives. */
export async function bundle(entry: string): Promise<string> {
  const { metafile, outputFiles } = await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node20',
    external: ['@playwright/test'], plugins: [formatFromSource],
    write: false, metafile: true, charset: 'utf8', logLevel: 'silent', outfile: OUT_FILE,
  });
  const imports = Object.values(metafile.outputs).flatMap((o) => o.imports.map((i) => i.path));
  const bad = imports.filter((p) => !p.startsWith('node:') && p !== '@playwright/test');
  if (bad.length > 0) {
    throw new Error(`standalone bundle imports ${bad.join(', ')}; only node:* and @playwright/test exist on an Engine`);
  }
  return outputFiles[0]!.text;
}

export interface StandaloneBuild {
  /** Absolute path of the emitted dist-standalone/bzm-playwright-vitals.ts. */
  outFile: string;
  /** The emitted source, for callers that want to copy it elsewhere. */
  source: string;
}

export async function buildStandalone(): Promise<StandaloneBuild> {
  const pkg = JSON.parse(await readFile(join(COLLECTOR_DIR, 'package.json'), 'utf8')) as { version: string };
  const header = [
    '// @ts-nocheck',
    `// bzm-playwright-vitals.ts: STANDALONE build of bzm-playwright-vitals v${pkg.version}, built ${new Date().toISOString()}`,
    '// DO NOT HAND-EDIT. GENERATED (esbuild bundle, bzm-vitals-format inlined) by',
    '//   packages/collector/scripts/build-standalone.ts   (npm run build:standalone)',
    '// Upload it to a BlazeMeter test next to a spec that does:',
    "//   import { test, expect } from './bzm-playwright-vitals';",
    '// It is not a second source of truth; adopt via npm when published.',
    '',
  ].join('\n');
  const source = header + (await bundle(join(COLLECTOR_DIR, 'src', 'index.ts')));

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, source, 'utf8');
  await copyFile(OUT_FILE, UPLOAD_KIT_COPY); // keep the upload kit's copy in lockstep
  return { outFile: OUT_FILE, source };
}

// CLI entry (npm run build:standalone). Guarded so the harness can import buildStandalone.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildStandalone()
    .then(({ outFile }) => console.log(`standalone collector written: ${outFile}\nupload-kit copy refreshed:    ${UPLOAD_KIT_COPY}`))
    .catch((err) => (console.error(err), process.exit(1)));
}
