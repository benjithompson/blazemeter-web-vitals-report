---
'bzm-vitals-dashboard': minor
---

Tests are grouped, and Outcomes joined to their Samples, by `test.id` when the records
carry one, else by file + title + project as before. Two Tests that share a spec name and
a title are now two rows, labelled by their describe chain and spec path. A Report that
mixes old and new collector records keeps one row per Test where the match is
unambiguous.
