// The Route-derivation table: every row is [declared route | undefined, url, expected Route].
// It was first run against BOTH pre-B1 copies of routeOf (collector shared.ts and dashboard
// aggregate.ts) to prove they behaved identically before the move; it now pins the one copy
// that lives in format.

export const ROUTE_TABLE: ReadonlyArray<readonly [route: string | undefined, url: string, expected: string]> = [
  // A declared Route always wins, verbatim — even when it is empty or looks like a URL.
  ['/order/{id}', 'https://example.com/order/12345', '/order/{id}'],
  ['', 'https://example.com/order/12345', ''],
  ['https://not-a-route/x?y', 'https://example.com/a', 'https://not-a-route/x?y'],
  ['/checkout', 'not a url at all', '/checkout'],
  // Absolute URLs: the parsed pathname, query and fragment stripped.
  [undefined, 'https://example.com/', '/'],
  [undefined, 'https://example.com', '/'],
  [undefined, 'https://example.com/order/12345?x=1#frag', '/order/12345'],
  [undefined, 'https://example.com/order/98765', '/order/98765'],
  [undefined, 'https://example.com/a/b/', '/a/b/'],
  [undefined, 'https://example.com:8443/p?q=1', '/p'],
  [undefined, 'HTTPS://EXAMPLE.COM/Mixed/Case', '/Mixed/Case'],
  [undefined, 'https://example.com/a b', '/a%20b'],
  [undefined, 'https://example.com/café', '/caf%C3%A9'],
  [undefined, 'https://example.com/./a/../b', '/b'],
  [undefined, 'http://[::1]:3000/v6', '/v6'],
  [undefined, 'https://example.com/#only-fragment', '/'],
  [undefined, 'file:///tmp/fixture.html', '/tmp/fixture.html'],
  [undefined, 'about:blank', 'blank'],
  [undefined, 'data:text/html,<p>hi</p>', 'text/html,<p>hi</p>'],
  [undefined, 'javascript:void(0)', 'void(0)'],
  // Not URL-parseable: the hand-rolled strip keeps everything before the first ? or #.
  [undefined, '/order/9?x=1#y', '/order/9'],
  [undefined, '/order/9#y?x=1', '/order/9'],
  [undefined, 'order/1', 'order/1'],
  [undefined, '//cdn.example.com/p?x', '//cdn.example.com/p'],
  [undefined, '?q=1', ''],
  [undefined, '#frag', ''],
  [undefined, '', ''],
  [undefined, 'not a url at all', 'not a url at all'],
];
