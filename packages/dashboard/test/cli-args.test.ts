// D2 (#31) — the command line is parsed by node:util parseArgs, strictly.
//
// The bug this replaces: the hand-rolled loop did `masterId = argv[++i]`, so a
// trailing `--master` became `undefined` and `--master --out r.html` swallowed
// `--out` as the master id. A malformed command line now exits 2 with ONE line
// naming the problem plus a hint to use --help; `--help` / `--version` print
// and exit 0 without touching the network or the filesystem.

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cli from '../src/cli.js';
import { runCli } from '../src/cli.js';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_SRC = path.join(HERE, '../src/cli.ts');
const TSX_CLI = path.join(HERE, '../../../node_modules/tsx/dist/cli.mjs');

const noNetwork = () => {
  throw new Error('network call while parsing arguments');
};

/** Run the CLI in-process; resolve to the thrown error (or fail if none). */
async function failure(argv: string[]): Promise<Error & { exitCode?: number }> {
  return runCli({ argv, env: {}, transport: noNetwork, log: () => {}, print: () => {} }).then(
    () => {
      throw new Error(`expected ${JSON.stringify(argv)} to fail`);
    },
    (err: Error & { exitCode?: number }) => err,
  );
}

function expectMalformed(err: Error & { exitCode?: number }, problem: RegExp): void {
  expect(err.exitCode).toBe(2);
  const [first, hint, ...rest] = err.message.split('\n');
  expect(first).toMatch(/^bzm-vitals-dashboard: /);
  expect(first).toMatch(problem);
  expect(hint).toBe("Run 'bzm-vitals-dashboard --help' for usage.");
  expect(rest).toEqual([]);
}

describe('a malformed command line exits 2 with a one-line reason and a --help hint', () => {
  it('--master with no value is a clear error, never an undefined master id', async () => {
    expectMalformed(await failure(['--out', 'r.html', '--master']), /^bzm-vitals-dashboard: option '--master' needs a value$/);
  });

  it('--master followed by another flag does not swallow that flag as its value', async () => {
    expectMalformed(await failure(['--master', '--out', 'r.html']), /^bzm-vitals-dashboard: option '--master' needs a value$/);
  });

  it('--out and --artifacts with no value are errors too', async () => {
    expectMalformed(await failure(['--master', '1', '--out']), /option '--out' needs a value$/);
    expectMalformed(await failure(['--out', 'r.html', '--artifacts']), /option '--artifacts' needs a value$/);
  });

  it('an empty inline value (--master=) is as missing as no value', async () => {
    expectMalformed(await failure(['--master=', '--out', 'r.html']), /option '--master' needs a non-empty value$/);
  });

  it('an unknown flag names itself', async () => {
    expectMalformed(await failure(['--mastr', '1', '--out', 'r.html']), /unknown option '--mastr'$/);
    expectMalformed(await failure(['-m', '1', '--out', 'r.html']), /unknown option '-m'$/);
  });

  it('a boolean flag given a value is an error, not silently true', async () => {
    expectMalformed(await failure(['--help=yes']), /option '--help' takes no value$/);
  });

  it('a stray positional is rejected, not ignored', async () => {
    expectMalformed(await failure(['82723459', '--out', 'r.html']), /unexpected argument '82723459'$/);
  });

  it('no command at all still prints the usage and exits 1, like the installed bin always has', async () => {
    for (const argv of [[], ['--master', '1'], ['--out', 'r.html']]) {
      const err = await failure(argv);
      expect(err.exitCode).toBe(1);
      expect(err.message).toMatch(/^usage: bzm-vitals-dashboard --master <masterId> --out <report\.html>/);
    }
  });
});

describe('--help and --version', () => {
  async function printed(argv: string[]): Promise<{ text: string; outPath: string | null }> {
    const lines: string[] = [];
    const { outPath } = await runCli({
      argv,
      env: {},
      transport: noNetwork,
      log: () => {},
      print: (t) => lines.push(t),
    });
    return { text: lines.join('\n'), outPath };
  }

  it('--help documents both input modes, every flag, and the credential env vars', async () => {
    const { text, outPath } = await printed(['--help']);
    expect(outPath).toBeNull();
    for (const needle of [
      'usage: bzm-vitals-dashboard --master <masterId> --out <report.html>',
      '--artifacts <zip-or-folder> [--master <masterId>] --out <report.html>',
      '--master <masterId>',
      '--artifacts <zip-or-folder>',
      '--out <report.html>',
      '-h, --help',
      '--version',
      'BLAZEMETER_API_KEY ',
      'BLAZEMETER_API_KEY_ID',
      'BLAZEMETER_API_KEY_SECRET',
    ]) {
      expect(text).toContain(needle);
    }
  });

  it('-h is --help, and help wins over an otherwise-complete command (nothing is fetched or written)', async () => {
    const help = (await printed(['--help'])).text;
    expect((await printed(['-h'])).text).toBe(help);
    expect(await printed(['--master', '1', '--out', 'r.html', '-h'])).toEqual({ text: help, outPath: null });
  });

  it('--version prints exactly the package.json version', async () => {
    const pkg = JSON.parse(await readFile(path.join(HERE, '../package.json'), 'utf8')) as { version: string };
    expect(cli.DASHBOARD_VERSION).toBe(pkg.version);
    expect(await printed(['--version'])).toEqual({ text: pkg.version, outPath: null });
  });
});

describe('the executable wrapper maps the error to the exit code', () => {
  const run = (args: string[]) =>
    execFileP(process.execPath, [TSX_CLI, CLI_SRC, ...args], { env: { PATH: process.env.PATH } }).then(
      (r) => ({ code: 0, ...r }),
      (err: { code: number; stdout: string; stderr: string }) => err,
    );

  it('--master with no value: exit 2, two lines on stderr, no stack trace', async () => {
    const r = await run(['--out', 'r.html', '--master']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr.trimEnd().split('\n')).toEqual([
      "bzm-vitals-dashboard: option '--master' needs a value",
      "Run 'bzm-vitals-dashboard --help' for usage.",
    ]);
  }, 30_000);

  it('--version: exit 0, the version alone on stdout', async () => {
    const r = await run(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${cli.DASHBOARD_VERSION}\n`);
  }, 30_000);
});
