---
'bzm-vitals-dashboard': minor
---

Artifacts are read lazily, in memory: only the vitals records inside each `artifacts.zip`
are inflated and checksum-verified, and the videos, traces and HTML reports beside them
are skipped. The API path no longer extracts zips into the cache, and session folders an
older cache extracted are removed. `--extract <dir>` stays, as a debugging aid only.
