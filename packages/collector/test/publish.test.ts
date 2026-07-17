/**
 * The publish seam — assert the tarball npm would actually ship, not the
 * package.json we hope it reads. Every failure class here is silent at
 * publish time and fatal on the Engine: a tarball missing dist/, a workspace
 * dep that only resolves via symlink, an import specifier that isn't the
 * published name.
 *
 * `npm pack --dry-run --json` builds the real file list without writing a
 * tarball — the same computation `npm publish` uses.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);

const COLLECTOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORMAT_DIR = join(COLLECTOR_DIR, '..', 'format');

/** A version that is only ever an exact release — file:/link:/workspace: specifiers fail this. */
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

async function packedPaths(pkgDir: string): Promise<string[]> {
  const { stdout } = await execFileP('npm', ['pack', '--dry-run', '--json'], {
    cwd: pkgDir,
  });
  const [report] = JSON.parse(stdout) as [{ files: Array<{ path: string }> }];
  return report.files.map((f) => f.path);
}

describe('collector tarball (bzm-playwright-vitals)', () => {
  it('ships dist, README, LICENSE — and nothing that only works in this repo', async () => {
    const paths = await packedPaths(COLLECTOR_DIR);

    expect(paths).toContain('dist/index.js');
    expect(paths).toContain('dist/index.d.ts');
    expect(paths).toContain('package.json');
    expect(paths).toContain('README.md');
    expect(paths).toContain('LICENSE');

    // Source, tests, kits, and the standalone build artifact stay home.
    const leaked = paths.filter((p) =>
      /^(src|test|scripts|upload-kit|dist-standalone)\//.test(p),
    );
    expect(leaked).toEqual([]);
  });

  it('declares Playwright as a peerDependency and the format dep as exact published semver', async () => {
    const pkg = JSON.parse(await readFile(join(COLLECTOR_DIR, 'package.json'), 'utf8'));

    expect(pkg.private).toBeUndefined();
    expect(pkg.name).toBe('bzm-playwright-vitals');
    // Playwright is the suite's, never ours — a real dependency would force a
    // second Playwright install on the Engine.
    expect(pkg.dependencies?.['@playwright/test']).toBeUndefined();
    expect(pkg.peerDependencies?.['@playwright/test']).toMatch(/^>=/);
    expect(pkg.dependencies['bzm-vitals-format']).toMatch(EXACT_SEMVER);
  });

  it('the packed entry point imports the format dep by its published name', async () => {
    const dist = await readFile(join(COLLECTOR_DIR, 'dist', 'index.js'), 'utf8');
    expect(dist).toMatch(/from\s+['"]bzm-vitals-format['"]/);
    // No relative escape from the tarball, no leftover scoped name.
    expect(dist).not.toMatch(/from\s+['"]\.\.\//);
    expect(dist).not.toMatch(/@bzm\//);
  });
});

describe('format tarball (bzm-vitals-format)', () => {
  it('is publishable and ships dist + LICENSE', async () => {
    const pkg = JSON.parse(await readFile(join(FORMAT_DIR, 'package.json'), 'utf8'));
    expect(pkg.private).toBeUndefined();
    expect(pkg.name).toBe('bzm-vitals-format');
    expect(pkg.version).toMatch(EXACT_SEMVER);

    const paths = await packedPaths(FORMAT_DIR);
    expect(paths).toContain('dist/index.js');
    expect(paths).toContain('dist/index.d.ts');
    expect(paths).toContain('LICENSE');
    expect(paths.filter((p) => p.startsWith('src/'))).toEqual([]);
  });
});
