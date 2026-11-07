#!/usr/bin/env node
// Link check for the repo's Markdown: every relative link must point at a path
// that exists, and every #anchor into a Markdown file must name one of its
// headings (GitHub's slug rules) or an explicit <a id/name>. External links
// (any scheme, or protocol-relative) are not fetched — CI must not depend on
// the network. Plain Node built-ins only, so it runs with no install step.
//
// Usage: node scripts/check-links.mjs [rootDir]   (exit 1 on any broken link)

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

// Dot-directories are skipped (worktrees, caches, .git) except these two, which
// hold tracked Markdown.
const DOT_DIRS_KEPT = new Set(['.changeset', '.github']);
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'test-results', 'playwright-report']);

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && !DOT_DIRS_KEPT.has(entry.name)) continue;
      out.push(...markdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/** The file's lines with fenced code blocks blanked, so their contents are
 *  neither links nor headings. Line count is preserved for error positions. */
function proseLines(text) {
  let fence = null;
  return text.split('\n').map((line) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      return '';
    }
    if (m) {
      fence = m[1];
      return '';
    }
    return line;
  });
}

/** GitHub's heading slug: lowercase, drop punctuation (keeping letters,
 *  digits, `_`, `-` and spaces), spaces become `-`. */
function slug(heading) {
  const text = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/<[^>]+>/g, '') // inline HTML tags
    .trim()
    .toLowerCase();
  return text.replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, '').replace(/ /g, '-');
}

const anchorCache = new Map();
function anchorsOf(file) {
  let anchors = anchorCache.get(file);
  if (anchors) return anchors;
  anchors = new Set();
  const seen = new Map();
  for (const line of proseLines(readFileSync(file, 'utf8'))) {
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const base = slug(h[1]);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const a of line.matchAll(/<a\s[^>]*\b(?:id|name)=["']([^"']+)["']/gi)) anchors.add(a[1]);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

/** Every link target on a line: inline [text](target) / ![alt](target) and
 *  reference definitions `[label]: target`. Inline code spans are ignored. */
function linkTargets(line) {
  const prose = line.replace(/`+[^`]*`+/g, (s) => ' '.repeat(s.length));
  const targets = [];
  for (const m of prose.matchAll(/\]\(\s*(<[^>]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+["'(][^)]*)?\)/g)) {
    targets.push(m[1].replace(/^<|>$/g, ''));
  }
  const def = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(prose);
  if (def) targets.push(def[1].replace(/^<|>$/g, ''));
  return targets;
}

const problems = [];
const files = markdownFiles(root);
let checked = 0;
for (const file of files) {
  const lines = proseLines(readFileSync(file, 'utf8'));
  lines.forEach((line, i) => {
    for (const raw of linkTargets(line)) {
      if (raw === '' || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) continue;
      checked++;
      const where = `${path.relative(root, file)}:${i + 1}`;
      const hashAt = raw.indexOf('#');
      const rawPath = (hashAt === -1 ? raw : raw.slice(0, hashAt)).split('?')[0];
      const anchor = hashAt === -1 ? null : decodeURIComponent(raw.slice(hashAt + 1));
      let target;
      try {
        target = rawPath === '' ? file : path.resolve(path.dirname(file), decodeURIComponent(rawPath));
      } catch {
        problems.push(`${where}: malformed link ${raw}`);
        continue;
      }
      if (!existsSync(target)) {
        problems.push(`${where}: ${raw} -> no such path`);
        continue;
      }
      if (anchor && target.endsWith('.md') && statSync(target).isFile() && !anchorsOf(target).has(anchor)) {
        problems.push(`${where}: ${raw} -> no heading or anchor "#${anchor}" in ${path.relative(root, target)}`);
      }
    }
  });
}

if (problems.length > 0) {
  console.error(`check-links: ${problems.length} broken link(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-links: ${checked} relative link(s) across ${files.length} Markdown file(s), all resolve.`);
