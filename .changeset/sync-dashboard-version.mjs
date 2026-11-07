// Run by `npm run version-packages` right after `changeset version`.
//
// The dashboard's --version string is a constant in src/cli.ts (DASHBOARD_VERSION), so the
// one-file standalone builds carry it with no package.json beside them. `changeset version`
// only rewrites package.json, so this copies the new version into the constant.
// packages/dashboard/test/cli-args.test.ts fails if the two ever drift.
import { readFile, writeFile } from 'node:fs/promises';

const dashboard = new URL('../packages/dashboard/', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', dashboard), 'utf8'));
const cliUrl = new URL('src/cli.ts', dashboard);
const src = await readFile(cliUrl, 'utf8');
const pattern = /export const DASHBOARD_VERSION = '[^']*';/;
if (!pattern.test(src)) {
  throw new Error('sync-dashboard-version: DASHBOARD_VERSION not found in packages/dashboard/src/cli.ts');
}
const next = src.replace(pattern, `export const DASHBOARD_VERSION = '${version}';`);
if (next !== src) {
  await writeFile(cliUrl, next);
  console.log(`sync-dashboard-version: DASHBOARD_VERSION -> ${version}`);
}
