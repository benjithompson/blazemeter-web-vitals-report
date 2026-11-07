#!/usr/bin/env tsx
// Builds the ONE-FILE variants of the dashboard CLI, for users with no npm (or no repo):
//   dist-standalone/bzm-vitals-dashboard.mjs   node bzm-vitals-dashboard.mjs ...   (any Node >= 20)
//   dist-standalone/bzm-vitals-dashboard.ts    npx tsx bzm-vitals-dashboard.ts ...  (or Node type stripping)
//
// esbuild bundles src/cli.ts with bzm-vitals-format inlined from its SOURCE (never a stale
// dist/), on every run. Both files carry the same JavaScript; the .ts adds // @ts-nocheck. The
// build FAILS if the bundle imports anything but node:* builtins, since the point is no npm
// install. The artifacts are gitignored; test/standalone.test.ts rebuilds them first.

import { build, type Plugin } from 'esbuild';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DASHBOARD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORMAT_SRC = join(DASHBOARD_DIR, '..', 'format', 'src', 'index.ts');
const OUT_FILE = join(DASHBOARD_DIR, 'dist-standalone', 'bzm-vitals-dashboard.ts');
const OUT_FILE_MJS = OUT_FILE.replace(/\.ts$/, '.mjs');

/** Resolve the workspace format package to its source file, so the bundle can never lag it. */
const formatFromSource: Plugin = {
  name: 'bzm-vitals-format-from-source',
  setup: (b) => void b.onResolve({ filter: /^bzm-vitals-format$/ }, () => ({ path: FORMAT_SRC })),
};

/** Bundle `entry` to ESM JavaScript (no hashbang); throws if any import but node:* survives. */
export async function bundle(entry: string): Promise<string> {
  const { metafile, outputFiles } = await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node20',
    plugins: [formatFromSource], write: false, metafile: true, charset: 'utf8', logLevel: 'silent', outfile: OUT_FILE_MJS,
  });
  const imports = Object.values(metafile.outputs).flatMap((o) => o.imports.map((i) => i.path));
  const bad = imports.filter((p) => !p.startsWith('node:'));
  if (bad.length > 0) throw new Error(`standalone bundle imports ${bad.join(', ')}; only node:* resolves with no npm install`);
  return outputFiles[0]!.text.replace(/^#![^\n]*\n/, '');
}

export interface StandaloneBuild {
  /** Absolute path of the emitted dist-standalone/bzm-vitals-dashboard.ts. */
  outFile: string;
  /** The emitted source, for callers that want to copy it elsewhere. */
  source: string;
  /** Absolute path of the emitted dist-standalone/bzm-vitals-dashboard.mjs. */
  mjsFile: string;
  /** The emitted plain-JavaScript source. */
  mjsSource: string;
}

export async function buildStandalone(): Promise<StandaloneBuild> {
  const pkg = JSON.parse(await readFile(join(DASHBOARD_DIR, 'package.json'), 'utf8')) as { version: string };
  const header = (file: string, run: string) => [
    `// ${file}: STANDALONE build of bzm-vitals-dashboard v${pkg.version}, built ${new Date().toISOString()}`,
    '// Turns a finished BlazeMeter Playwright run into ONE self-contained report.html:',
    `//   ${run} --artifacts <zip-or-folder> --out report.html   # offline, no credentials`,
    `//   ${run} --master <masterId> --out report.html           # BLAZEMETER_API_KEY or _ID/_SECRET`,
    '// DO NOT HAND-EDIT. GENERATED (esbuild bundle, bzm-vitals-format inlined) by',
    '//   packages/dashboard/scripts/build-standalone.ts   (npm run build:standalone)',
    '',
  ].join('\n');
  const js = await bundle(join(DASHBOARD_DIR, 'src', 'cli.ts'));
  const source = `// @ts-nocheck\n${header('bzm-vitals-dashboard.ts', 'npx tsx bzm-vitals-dashboard.ts')}${js}`;
  const mjsSource = `#!/usr/bin/env node\n${header('bzm-vitals-dashboard.mjs', 'node bzm-vitals-dashboard.mjs')}${js}`;

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, source, 'utf8');
  await writeFile(OUT_FILE_MJS, mjsSource, 'utf8');
  await chmod(OUT_FILE_MJS, 0o755);
  return { outFile: OUT_FILE, source, mjsFile: OUT_FILE_MJS, mjsSource };
}

// CLI entry (npm run build:standalone). Guarded so the harness can import buildStandalone.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildStandalone()
    .then(({ outFile, mjsFile }) => console.log(`standalone dashboard written: ${outFile}\nstandalone dashboard written: ${mjsFile}`))
    .catch((err) => (console.error(err), process.exit(1)));
}
