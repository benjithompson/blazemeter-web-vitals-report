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
    setTimeout(function () {
      var d = document.createElement('div');
      d.style.height = '120px';
      d.textContent = 'late content';
      document.body.insertBefore(d, document.body.firstChild);
    }, 50);
  </script>
</body>
</html>`;
}

const ROUTES: Record<string, string> = {
  '/': page('Home', '<p>landing content</p>'),
  '/second': page('Second', '<p>second content</p>'),
  '/third': page('Third', '<p>third content</p>'),
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
