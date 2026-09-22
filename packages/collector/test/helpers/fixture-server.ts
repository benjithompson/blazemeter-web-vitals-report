// A tiny static HTTP server the harness owns. The collector measures journey vitals on
// the page the test drove, so the harness must serve real pages over HTTP — file:// URLs
// distort TTFB (there is no response phase), which is exactly the metric under test.
//
// Reusable across issues #1/#3/#4/#10: the pages carry a contentful element (so FCP
// fires), a couple of routes to navigate between, a clickable target (so #3 can reach
// INP), and a layout-shifting element (so #3 can reach CLS).

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

function page(title: string, body: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family: sans-serif; margin: 2rem;">
  <h1>${title}</h1>
  ${body}
  <p><a href="/second">second</a> &middot; <a href="/third">third</a> &middot; <a href="/">home</a></p>
  <button id="target">click me</button>
  <script>
    // A late layout shift so #3 has a non-zero CLS to measure. Harmless to the tracer.
    // Timed from FIRST PAINT, not from script start: content inserted before anything
    // was painted moves nothing, so the browser honestly reports no shift. (Measured on
    // Playwright 1.63 under parallel load: first paint can land 400ms+ after the script
    // runs.) The 1s backstop keeps the page shifting where paint timing is absent.
    var shiftScheduled = false;
    function scheduleShift() {
      if (shiftScheduled) return;
      shiftScheduled = true;
      setTimeout(function () {
        var d = document.createElement('div');
        d.style.height = '120px';
        d.textContent = 'late content';
        document.body.insertBefore(d, document.body.firstChild);
      }, 50);
    }
    try {
      new PerformanceObserver(function (list) {
        var es = list.getEntries();
        for (var i = 0; i < es.length; i++) {
          if (es[i].name === 'first-contentful-paint') scheduleShift();
        }
      }).observe({ type: 'paint', buffered: true });
    } catch (e) {}
    setTimeout(scheduleShift, 1000);
    // The click target does two things a spec can rely on:
    //  - burns ~30ms so the interaction's duration clears event-timing's 16ms
    //    durationThreshold floor (a no-op handler can finish under it and emit nothing);
    //  - appends a visible #clicked-flag the spec can await, which forces the paint
    //    that finalizes the interaction's duration before the journey moves on.
    // The appended flag also shifts layout WITH recent input — CLS must exclude it.
    document.getElementById('target').addEventListener('click', function () {
      var start = performance.now();
      while (performance.now() - start < 30) { /* deliberate jank */ }
      var p = document.createElement('p');
      p.id = 'clicked-flag';
      p.textContent = 'clicked';
      document.body.appendChild(p);
    });
  </script>
</body>
</html>`;
}

// The hostile page sabotages the trap's flush-time reads. Page scripts run AFTER init
// scripts, so the trap's observers are already registered when this runs — which is the
// point: LCP/CLS ride on observer state and survive; TTFB/FCP are read from the (now
// throwing) timeline at flush and must land as status 'error', with the Sample intact.
const HOSTILE = page('Hostile', `<p>hostile content</p>
  <script>
    performance.getEntriesByType = function () { throw new Error('sabotaged by fixture'); };
  </script>`);

const ROUTES: Record<string, string> = {
  '/': page('Home', '<p>landing content</p>'),
  '/second': page('Second', '<p>second content</p>'),
  '/third': page('Third', '<p>third content</p>'),
  '/hostile': HOSTILE,
};

export interface FixtureServer {
  url: string;
  close: () => Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    const html = ROUTES[pathname];
    if (html === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
