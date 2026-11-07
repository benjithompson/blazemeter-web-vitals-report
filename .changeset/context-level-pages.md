---
'bzm-playwright-vitals': minor
---

Every page a test opens in its context is measured, not only the `page` fixture: popups
(`page.waitForEvent('popup')`) and `context.newPage()` pages now write Samples too. Each
Sample carries `pageIndex` (0 = the context's first page, then in open order), and a
page or context the test closes itself still records its last Navigation. A context
created with `browser.newContext()` is not measured.
