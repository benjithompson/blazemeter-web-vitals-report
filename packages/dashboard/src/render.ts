// The emitter — ONE self-contained static HTML file.
//
// The data is embedded as a parseable JSON blob (<script type="application/json"
// id="bzm-vitals-data">). That blob is a PRODUCT requirement, not a test hook:
// the pre-signed dataUrl expires in 20 minutes, so the data must be baked in at
// build time for the artifact to be permanent. Seam 2 parses the blob back out.
//
// Hard rules, asserted on the emitted bytes by the tests:
//   - ZERO external requests: no <script src>, <link href>, <img src>, no
//     remote fetch/XHR — the file renders offline, in six months, unchanged;
//   - NO credentials and NO pre-signed URLs, ever;
//   - a Report with zero vitals says "no samples", never 0.
//
// The visual layer here is the tracer's minimum — a Route table with p75 and
// coverage. Issue #6 makes the statistics right (p50/p95, Cold Starts,
// thresholds); issue #7 makes the table good.

import type { ReportData } from './report.js';

export const DATA_BLOB_ID = 'bzm-vitals-data';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * JSON for embedding inside a <script> element. Escaping every "<" as \u003c
 * makes "</script>" (and "<!--") impossible in the payload while remaining
 * plain JSON — JSON.parse reads it back identically.
 */
function embedJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

// The inline renderer. Everything it needs is in the blob; it touches no
// network. Kept as a plain string so the emitted file has no build products.
const INLINE_SCRIPT = `
  var data = JSON.parse(document.getElementById('${DATA_BLOB_ID}').textContent);

  // Canonical metric order first, then whatever else the open name set carried.
  var KNOWN = ['ttfb', 'fcp', 'lcp', 'cls', 'inp'];
  var names = [];
  data.routes.forEach(function (row) {
    Object.keys(row.metrics).forEach(function (n) {
      if (names.indexOf(n) === -1) names.push(n);
    });
  });
  names.sort(function (a, b) {
    var ia = KNOWN.indexOf(a), ib = KNOWN.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a < b ? -1 : 1;
  });

  function fmt(name, value) {
    if (name === 'cls') return String(Math.round(value * 100000) / 100000);
    return Math.round(value) + ' ms';
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  var engines = document.getElementById('engines');
  data.sessions.forEach(function (s) {
    var line = s.artifact === 'present'
      ? s.engineLabel + ' — ' + s.sampleCount + ' Samples'
      : s.engineLabel + ' — no artifact';
    if (s.unreadable.length > 0) line += ' (' + s.unreadable.length + ' unreadable)';
    var li = el('li', s.artifact === 'present' ? '' : 'no-artifact', line);
    li.title = s.sessionId;
    engines.appendChild(li);
  });

  var mount = document.getElementById('route-table');
  if (data.samples.length === 0) {
    mount.appendChild(el('p', 'no-samples', 'no samples — this Report carried no vitals records'));
  } else {
    var table = el('table');
    var thead = el('thead');
    var headRow = el('tr');
    headRow.appendChild(el('th', 'route-col', 'Route'));
    headRow.appendChild(el('th', '', 'Samples'));
    names.forEach(function (n) {
      headRow.appendChild(el('th', '', n.toUpperCase() + ' p75'));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    data.routes.forEach(function (row) {
      var tr = el('tr');
      tr.appendChild(el('td', 'route-col', row.route));
      tr.appendChild(el('td', 'num', String(row.sampleCount)));
      names.forEach(function (n) {
        var m = row.metrics[n];
        var td = el('td', 'num');
        if (!m || m.ok === 0) {
          // Nothing measured: the reason-shaped coverage, never a 0.
          td.appendChild(el('span', 'not-measured', '—'));
          td.appendChild(el('small', 'coverage', m ? '0 of ' + m.total : 'not carried'));
        } else {
          td.appendChild(el('span', 'value', fmt(n, m.p75)));
          td.appendChild(el('small', 'coverage', m.ok + ' of ' + m.total));
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    mount.appendChild(table);
  }
`;

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  .meta { color: #666; font-size: 0.85rem; }
  #engines { list-style: none; padding: 0; font-size: 0.9rem; }
  #engines li { padding: 0.15rem 0; }
  #engines li.no-artifact { color: #b00; }
  table { border-collapse: collapse; margin-top: 1rem; }
  th, td { padding: 0.4rem 0.9rem; border-bottom: 1px solid #ccc; text-align: right; }
  th.route-col, td.route-col { text-align: left; font-family: ui-monospace, monospace; }
  td.num .coverage { display: block; color: #777; font-weight: normal; }
  .not-measured { color: #999; }
  .no-samples { font-size: 1.1rem; color: #b00; }
`;

/** Render the whole report as one self-contained HTML document. */
export function renderHtml(data: ReportData): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Web Vitals — Report ${escapeHtml(data.masterId)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Web Vitals — Report ${escapeHtml(data.masterId)}</h1>
<p class="meta">lab / synthetic data · generated ${escapeHtml(data.generatedAt)} · p75 over pooled Attributed Samples, coverage beside every value</p>
<ul id="engines"></ul>
<div id="route-table"></div>
<script type="application/json" id="${DATA_BLOB_ID}">${embedJson(data)}</script>
<script>${INLINE_SCRIPT}</script>
</body>
</html>
`;
}
