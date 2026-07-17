// Regression guard for the 0.1.0 bin bug: npm installs the bin as a symlink, so
// process.argv[1] (the symlink) never equals import.meta.url (realpath-resolved)
// under a raw compare, and the CLI silently no-ops. isEntryPoint must resolve the
// symlink and still recognize the module as the entry point.

import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'node:url';
import { isEntryPoint } from '../src/cli.js';

const MODULE = '/pkg/node_modules/bzm-vitals-dashboard/dist/cli.js';
const MODULE_URL = pathToFileURL(MODULE).href;
const BIN_SYMLINK = '/pkg/node_modules/.bin/bzm-vitals-dashboard';

describe('isEntryPoint — the installed-bin symlink must count as the entry point', () => {
  it('resolves a bin symlink to the real module path (the shipped-broken case)', () => {
    // argv1 is the symlink; realpath resolves it to the real cli.js.
    const realpath = (p: string) => (p === BIN_SYMLINK ? MODULE : p);
    expect(isEntryPoint(MODULE_URL, BIN_SYMLINK, realpath)).toBe(true);
  });

  it('matches a direct (non-symlinked) invocation by real path', () => {
    expect(isEntryPoint(MODULE_URL, MODULE, (p) => p)).toBe(true);
  });

  it('is false when this module was imported, not executed (argv1 is another entry)', () => {
    const other = '/pkg/node_modules/vitest/dist/cli.js';
    expect(isEntryPoint(MODULE_URL, other, (p) => p)).toBe(false);
  });

  it('is false when argv1 is absent', () => {
    expect(isEntryPoint(MODULE_URL, undefined)).toBe(false);
  });

  it('falls back to the raw compare when realpath throws (unresolvable argv1)', () => {
    const throwing = () => {
      throw new Error('ENOENT');
    };
    // Raw path still equals the module URL, so it is the entry point.
    expect(isEntryPoint(MODULE_URL, MODULE, throwing)).toBe(true);
    // And a mismatch stays false rather than throwing.
    expect(isEntryPoint(MODULE_URL, '/somewhere/else.js', throwing)).toBe(false);
  });
});
