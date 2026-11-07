# bzm-vitals-dashboard

Generator, not viewer: point it at a BlazeMeter master (Report) id and get one
self-contained static HTML file with the data baked in. This package currently
implements issue #2 — the fetch/extract/cache layer the later views build on.

## The fetch/cache script

`scripts/fetch-cache.ts` is the **only** thing that talks to the live BlazeMeter
API. It walks the API chain for a master id and writes every Engine's artifact to
a local cache, **namespaced by `sessionId`**. The test suite reads
that cache and never touches the network; the script is run by hand and fails
loudly.

```bash
BLAZEMETER_API_KEY=./api-key.json \
  npx tsx packages/dashboard/scripts/fetch-cache.ts <masterId> [<masterId> ...]
```

It prints, per Engine: `sessionId`, `locationId`, status, and either
`artifact present — N files` or `NO ARTIFACT` (an Engine that terminated
ungracefully emits no zip — a normal outcome, not an error).

### What it writes

```
.artifact-cache/{masterId}/manifest.json     session list + per-Engine outcome + master status
.artifact-cache/{masterId}/{sessionId}.zip   raw fetched bytes, one zip per Engine
```

Nothing is extracted to disk. The report reads each cached zip in memory with
the same reader `--artifacts` uses, and inflates only the record entries
(`bzm-vitals-sample-*`, `bzm-vitals-outcome-*`, `performance-audit-*`). The
video, traces and HTML reports in an artifacts.zip are never decompressed.
(Caches written by earlier versions also held an extracted `{sessionId}/`
folder; the next run deletes it.) To look inside the zips, pass
`--extract <dir>`: it also unzips every Engine's cached artifacts into
`<dir>/{sessionId}/`. It is for debugging only. The report does not use it,
and it applies to `--master` only.

The script writes to the repo root's `.artifact-cache/`. The CLI uses, in order:

1. `--cache-dir <dir>`, when given;
2. otherwise `$BZM_VITALS_CACHE_DIR`, when set;
3. otherwise `./.artifact-cache` under the current directory.

This is the same for the installed bin, a repo checkout and the single-file
builds. (Earlier versions of the installed bin cached at the root of the project it was
installed into; run from there, or pass `--cache-dir`, to reuse that cache.)

Cross-Engine attachment basenames are **identical by construction** (basename is
`sha1` of the fixed absolute path Taurus passes to every Engine), so extracting
two Engines into one directory would silently destroy half the Samples.
Namespacing by `sessionId` is what prevents that: each zip is one Engine, and its
records are attributed to that Engine as they are read.

### Re-running is cheap

A second run against a master that had **ENDED** when it was cached does
**zero** network calls and needs no credentials: the manifest is trusted and
the records are read again from the cached raw zips. Because the cache keeps
the raw bytes, a change to the reader never forces a refetch.

A master cached while it was still running is not trusted: the next run lists
its sessions again and fetches only the ones that are new, unfinished or
changed. `--refresh` ignores the cache for that master and fetches every
session again (so does deleting `.artifact-cache/{masterId}/`).

Up to **4** Engines' artifacts download at once. Each zip and the manifest are
written to a `.tmp` file and renamed into place, so a run killed mid-download
leaves nothing a later run trusts. A cached zip that no longer reads (truncated
or corrupt) is deleted and fetched again, with a warning.

## Local import — `--artifacts <path>`

For when the network is unavailable, the CLI reads Engine artifacts from disk
instead of the API. The loader is `src/local.ts`.

```bash
npx bzm-vitals-dashboard --artifacts <zip-or-folder> [--master <masterId>] --out report.html
```

The path can be one `artifacts.zip`, its unzipped folder, a zip or folder that
holds several of them, or a local Playwright `test-results/` tree. There is no
API, so the loader infers each Engine from the layout:

1. A folder or zip named `r-v4-…` anywhere on a record's path is its Engine.
   That name is the real `sessionId`.
2. Otherwise, the innermost zip, or the innermost folder that holds `bzt.log`.
3. Otherwise, the input itself.

`foo.zip` and its unzipped `foo/` resolve to the same Engine, so a zip beside
its own extraction is not counted twice. Records are read in memory by path and
never flattened, because a `test-results/` tree repeats basenames. Local import
writes nothing to `.artifact-cache/` and needs no credentials. Without
`--master`, the report has no BlazeMeter link and says `imported from <name>`.
A path with no records and no `bzt.log` fails loudly.

## Malformed records are reported, not aggregated

Every Sample and Outcome is checked field by field against format v1
(`validateSample` / `validateOutcome` in `bzm-vitals-format`, also published as
JSON Schemas in its `schema/` folder). Some examples of what fails the check: a
metric value that is not a number, a status outside the closed vocabulary, a
value on a metric whose status is not `ok`, and a test identity missing
`project`. A record that fails is left out of every number in the report. The
Engine's line then says `(N unreadable)`, and the CLI's summary line counts
it. The report's embedded data keeps each file's name and the reason, which
names the field.
Records from collector 0.2.x stay valid. So do unknown metric names and the
optional fields added later (`test.id`, `titlePath`, `path`, `pageIndex`,
`lostNavigations`).

## Credentials — BlazeMeter's own convention

```bash
export BLAZEMETER_API_KEY=./api-key.json        # {"id": "...", "secret": "..."}

# CI — a file is awkward, so discrete vars are accepted:
BLAZEMETER_API_KEY_ID / BLAZEMETER_API_KEY_SECRET
```

The file form wins when both are present. Credentials authenticate only the two
listing calls; the artifact download URL is pre-signed and needs none.

> 🔴 `api-key.json` is gitignored and must stay so — a stray `git add -A` must
> never commit a live key.

## API host, timeouts and retries

```bash
export BLAZEMETER_API_BASE=https://a.blazemeter.com   # the default
```

`BLAZEMETER_API_BASE` points the listing calls at another BlazeMeter API host
(a private deployment, or a test double). The collector reads the same variable.
It must be an `http(s)` URL; a trailing `/` is ignored.

Every request has a deadline, so an unresponsive server fails the run instead
of hanging it:

- An API call gets **30 s**, headers and body together.
- An artifact download gets **120 s**, and is abandoned sooner if **30 s** pass
  with no bytes arriving.

A `429`, a `5xx` or a network error is retried up to **3 times**, with
exponential backoff plus jitter (about 0.5 s, 1 s, 2 s). A `Retry-After` header
is honoured, up to 60 s. A timeout is final and is not retried, and neither is
an untrusted TLS certificate (see the root README's proxy section). Error
messages name the host, and never print the pre-signed download URL's query
string, which is a live credential until it expires.

## The cache is gitignored and re-fetchable

`.artifact-cache/` is gitignored. Artifacts are a re-fetchable resource, not a
committed corpus — archiving is a storage tier, not an expiry, so a Report's zips
stay reachable long after the run. Anyone with account access can repopulate the
cache. The **one** committed exception is the stripped probe collision fixture in
`test/fixtures/probe/` (see its README).

## The report file, and how its inline script is built

`report.html` holds three things, all inline (its Content-Security-Policy lets it
load nothing else):

1. **The data, once**: the `ReportData` (attributed Samples, Outcomes, sessions,
   Route rows) as gzip-compressed, base64-encoded JSON in
   `<script type="application/gzip" data-encoding="base64" id="bzm-vitals-data">`.
2. **The code, once**: `src/browser/entry.ts` bundled for the browser. It unpacks
   the data with `DecompressionStream('gzip')`, builds the view with the same
   `view-model.ts` Node uses, and renders it with the same markup functions
   (`src/browser/views.ts`). The include-failed toggle recomputes the excluded
   view in the browser on its first flip, and each Route's drill-down is built
   when it is first opened.
3. **A fallback**: the Route table at p75 with coverage, rendered by Node, plus a
   `<noscript>` note. It stays in place, with the reason stated, when JavaScript
   is off, `DecompressionStream` is missing, or the render fails.

The bundle is generated, never committed: `scripts/build-browser.ts` runs esbuild
over `src/browser/entry.ts` (with `bzm-vitals-format` read from its source) and
writes the string constant `src/browser/bundle.generated.ts`, which `render.ts`
imports. The build fails if the bundle would import anything — platform `browser`
cannot resolve `node:*`, so `view-model.ts` stays isomorphic. Every path that
needs the bundle rebuilds it first:

| Command | How |
|---|---|
| `npm run typecheck` (root or this package), `npm run build` | `npm run build:browser` before `tsc --build` |
| `npm test` / any `vitest run` | `test/global-setup.ts` (vitest `globalSetup`) |
| `npm run build:standalone` | `scripts/build-standalone.ts` calls it before bundling `src/cli.ts` |

`test/browser-render.test.ts` is the drift guard: in Chromium, the view the page
builds must deep-equal the one Node builds from the same data, and the page's DOM
must equal the markup Node renders with the same functions.
