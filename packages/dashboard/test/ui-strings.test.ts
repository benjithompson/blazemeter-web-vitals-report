// Vocabulary — the UI speaks CONTEXT.md's words, and ONLY those words.
//
// Every human-facing label the renderer emits lives in the exported UI_STRINGS
// map; asserting on the map is the honest scope for the ban — "page" occurring
// inside a URL or a data value is legitimate data, but as a UI label the word
// is banned outright (ambiguous between URL and Route). Worker is never a
// dimension the UI offers.

import { describe, it, expect } from 'vitest';
import { UI_STRINGS } from '../src/ui-strings.js';

describe('UI strings — the vocabulary contract', () => {
  it('never says "Page" — banned as ambiguous between URL and Route', () => {
    for (const [key, value] of Object.entries(UI_STRINGS)) {
      expect(value, `UI_STRINGS.${key}`).not.toMatch(/page/i);
    }
  });

  it('never offers Worker as a dimension', () => {
    for (const [key, value] of Object.entries(UI_STRINGS)) {
      expect(value, `UI_STRINGS.${key}`).not.toMatch(/worker/i);
    }
  });

  it("speaks the glossary: Report, Route, Test, Engine, Navigation, Sample, Coverage, Cold Start", () => {
    const all = Object.values(UI_STRINGS).join(' · ');
    for (const word of [
      'Report',
      'Route',
      'Test',
      'Engine',
      'Navigation',
      'Sample',
      'Coverage',
      'Cold Start',
    ]) {
      expect(all).toContain(word);
    }
  });

  it('labels the data lab/synthetic — a word, not a caveat engine', () => {
    expect(UI_STRINGS.labData).toBe('lab data');
  });
});
