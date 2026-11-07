# Releasing (maintainers)

The three packages (`bzm-vitals-format`, `bzm-playwright-vitals`, `bzm-vitals-dashboard`)
are versioned with [Changesets](https://changesets.dev) and released by
[`.github/workflows/release.yml`](../.github/workflows/release.yml). Nobody publishes from
a laptop.

## Day to day

1. In a PR that changes what users get, add a changeset:

   ```bash
   npx changeset            # interactive: pick packages and bump type, write a summary
   # or, non-interactive:
   npx changeset --patch bzm-vitals-dashboard -m "Dashboard: clearer --help text"
   ```

   Commit the generated `.changeset/<random-name>.md` with the PR. A PR that changes
   only tests, docs or CI needs no changeset.
2. When PRs with changesets land on `main`, the release workflow opens (or updates) a
   **Version Packages** PR. It bumps versions, writes each package's `CHANGELOG.md`,
   updates the dashboard's `DASHBOARD_VERSION` constant and refreshes `package-lock.json`
   (`npm run version-packages`).
3. Merging the Version Packages PR releases. The workflow:
   - publishes every package whose version is not on npm yet, through npm trusted
     publishing, with provenance. `bzm-vitals-format` goes first.
   - pushes a `<package>@<version>` git tag for each published package.
   - creates one GitHub Release, tagged `release-<yyyymmdd>-<run>`, marked latest, with
     the three single-file builds attached: `bzm-playwright-vitals.ts`,
     `bzm-vitals-dashboard.mjs` and `bzm-vitals-dashboard.ts`. They are built from the
     release commit and never committed.

### A format bump cascades

The collector and the dashboard pin `bzm-vitals-format` exactly (`"0.2.0"`, not `^0.2.0`).
A changeset that bumps only the format therefore takes both dependents out of range, and
Changesets patch-bumps them and rewrites their pin (`updateInternalDependencies: "patch"`,
the default out-of-range rule). Their changelogs get an "Updated dependencies" entry.
You don't need to add changesets for them yourself.

## One-time setup (repository owner)

No secret is stored for publishing. Do these once:

1. **npm trusted publisher, for each of the three packages.** On npmjs.com, open the
   package, then *Settings* → *Trusted Publisher* → *GitHub Actions*, and enter:
   - Organization or user: `benjithompson`
   - Repository: `blazemeter-web-vitals-report`
   - Workflow filename: `release.yml`
   - Environment: leave empty (or, if you add an `environment:` to the `publish` job
     to require approval, enter that name)

   Then, under *Settings* → *Publishing access*, choose "Require two-factor
   authentication and disallow tokens" so that only this workflow can publish.
2. **GitHub repository settings.** Under *Settings* → *Actions* → *General* →
   *Workflow permissions*, check **Allow GitHub Actions to create and approve pull
   requests** (the Version Packages PR needs it).

### Fallback: an npm token

If trusted publishing can't be used, create a granular npm access token with publish
rights on the three packages. Store it as the repository secret `NPM_TOKEN`, and add this
to the "Publish" step of the `publish` job in `release.yml`:

```yaml
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

`actions/setup-node` already writes an `.npmrc` that reads `NODE_AUTH_TOKEN`. Provenance
still works, because the job keeps `id-token: write`. Tokens expire, so trusted publishing
is preferred.

## Checking a release locally (nothing is published)

```bash
npx changeset status --verbose        # what the pending changesets will bump
npx changeset publish-plan --output plan.json   # what is not on npm yet
npm run typecheck && npm publish --dry-run -w packages/dashboard   # tarball contents
```
