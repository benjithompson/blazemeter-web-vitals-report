---
'bzm-playwright-vitals': patch
---

README: drop the "keep each journey on one site" limitation. Re-verified on Playwright
1.63 (#13): a cross-site navigation by `goto()`, link click, form submit, location
assignment or history keeps the departing document's Sample, and a pending
`vitals.route()` lands on the document it was declared for. No code change.
