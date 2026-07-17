# Probe collision fixture — the one committed artifact

Two zips:

```
r-v4-6a596ee06d5a9077555455.zip   Engine on us-west-1
r-v4-6a596ee06dc10652779841.zip   Engine on us-west-2
```

They are the two Engines of BlazeMeter master **82724289** — the *probe run*:
plumbing-only, zero customer content. Each is stripped to **only its attachment
entries** (the six `probe-*.json` files), a few hundred bytes of `{"probe":true,
"tag":"...","ts":...}`. The bytes are **real fetched bytes, filtered** — the
attachment entries lifted straight out of the fetched zips, never synthesized.
Rebuild them with `scripts/build-probe-fixture.ts` (needs the cache populated by
`fetch-cache.ts 82724289`).

## Why these are committed while everything else is fetched

Every other artifact is re-fetchable from the API and lives in the gitignored
`.artifact-cache/` (see the package README). These two are the exception because
they carry the **cross-Engine filename collision** as real bytes, and the test
that depends on them — `test/collision.test.ts` — is the one that prevents a
failure this codebase has already suffered twice (half the Samples silently lost
to a filename collision). That test must never depend on account access, network,
or a retention tier, so its fixture is committed. Synthesizing a colliding pair
was rejected: it would test our *belief* about the collision, not the collision.

## The collision, concretely

All six attachment basenames are **identical** across the two Engines — the
basename is `sha1` of the fixed absolute path Taurus passes to every Engine:

```
probe-fixed.json
probe-path.json
probe-path-16816e1cb2abcc3ebbf681f0574171254cf8ea71.json
probe-path-77f2eb03080f3476f5101cb2c258c049cb830210.json
probe-path-7cfcddc89226a9ca0b0463abefc7580d0b9628b4.json
probe-path-fdc01ca402a2f00cfac4f52eb7bbf74128b1cb40.json
```

Same names, **different contents** (each Engine's `ts` differs) — so merging the
two into one directory would overwrite half of them. The collision test extracts
both through the `sessionId`-namespaced extractor and asserts all twelve survive.
