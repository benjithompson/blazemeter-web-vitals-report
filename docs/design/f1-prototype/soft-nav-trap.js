// F1 prototype: a standalone soft-Navigation trap. NOT production code, never shipped,
// never imported by packages/*. run-prototype.mjs reads this file and injects it with
// context.addInitScript, the same passive injection the real trap uses (X4).
//
// What it proves, beside the real trap's hard-Navigation logic:
//   1. support detection: 'soft-navigation' in PerformanceObserver.supportedEntryTypes;
//   2. slicing one document's timeline into Navigations: the hard one (time 0) and one
//      per soft-navigation entry, each a half-open window [start_i, start_i+1);
//   3. per-slice metrics: CLS and INP restart per slice; soft FCP from the entry's
//      presentationTime; soft LCP from interaction-contentful-paint; TTFB not carried;
//   4. the triggering interaction belongs to the slice it LEAVES (web-vitals' rule), and
//      whether entries' own navigationId agrees with the time-window assignment.
//
// It reports to Node through the binding only when the browser hands it an entry
// (a soft-navigation entry arriving) and when the runner calls the flush hook between
// steps, which is the real fixture's teardown-flush pattern. Nothing touches the page
// during load.
(function () {
  if (window.top !== window) return;
  var BINDING = '__f1Report';
  var supported = [];
  try { supported = (window.PerformanceObserver && PerformanceObserver.supportedEntryTypes) || []; } catch (e) {}
  function has(t) { return supported.indexOf(t) >= 0; }
  var softSupported = has('soft-navigation');

  // Plain copies of entries (toJSON where the engine provides it, plus the fields we read).
  function plain(e) {
    var o = {};
    try { o = e.toJSON ? e.toJSON() : {}; } catch (x) {}
    ['entryType', 'name', 'startTime', 'duration', 'navigationId', 'interactionId', 'paintTime',
     'presentationTime', 'renderTime', 'loadTime', 'size', 'value', 'hadRecentInput'].forEach(function (k) {
      try { if (e[k] !== undefined && typeof e[k] !== 'function' && typeof e[k] !== 'object') o[k] = e[k]; } catch (x) {}
    });
    return o;
  }

  var store = { softNavs: [], icp: [], lcp: [], shifts: [], events: [], paint: [] };
  function observe(type, bucket, opts, onEntry) {
    if (!has(type)) return;
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          bucket.push(e);
          if (onEntry) onEntry(e);
        });
      }).observe(Object.assign({ type: type, buffered: true }, opts || {}));
    } catch (e) {}
  }

  observe('soft-navigation', store.softNavs, null, function (e) {
    // Passive: a page-to-Node message carrying an entry the browser already produced.
    try {
      window[BINDING]({ kind: 'soft-navigation-seen', at: performance.timeOrigin + performance.now(), entry: plain(e) });
    } catch (x) {}
  });
  observe('interaction-contentful-paint', store.icp);
  observe('largest-contentful-paint', store.lcp);
  observe('layout-shift', store.shifts);
  observe('event', store.events, { durationThreshold: 16 });
  observe('first-input', store.events);
  observe('paint', store.paint);

  function clsOf(shifts) {
    var max = 0, cur = 0, first = 0, prev = 0;
    shifts.forEach(function (e) {
      if (e.hadRecentInput) return;
      if (cur > 0 && e.startTime - prev < 1000 && e.startTime - first < 5000) cur += e.value;
      else { cur = e.value; first = e.startTime; }
      prev = e.startTime;
      if (cur > max) max = cur;
    });
    return max;
  }

  var lastAgreement = null;
  function slices() {
    var nav = performance.getEntriesByType('navigation')[0];
    var list = [{
      navigationType: 'hard',
      start: 0,
      url: nav ? nav.name : location.href,
      navigationId: nav ? nav.navigationId : undefined,
      interactionId: null,
      entry: null
    }];
    store.softNavs.slice().sort(function (a, b) { return a.startTime - b.startTime; }).forEach(function (s) {
      list.push({ navigationType: 'soft', start: s.startTime, url: s.name, navigationId: s.navigationId,
                  interactionId: s.interactionId, entry: s });
    });

    // Which slice does a time / interaction belong to? The trigger of slice i+1 belongs to i.
    function sliceAt(t) {
      var k = 0;
      for (var i = 0; i < list.length; i++) if (list[i].start <= t) k = i;
      return k;
    }
    function sliceOfInteraction(e) {
      for (var i = 1; i < list.length; i++) if (e.interactionId && e.interactionId === list[i].interactionId) return i - 1;
      return sliceAt(e.startTime);
    }

    var shiftBuckets = list.map(function () { return []; });
    store.shifts.forEach(function (e) { shiftBuckets[sliceAt(e.startTime)].push(e); });

    var inpBuckets = list.map(function () { return {}; });
    var idAgreement = lastAgreement = { agree: 0, disagree: 0, noNavigationId: 0 };
    store.events.forEach(function (e) {
      var key = e.interactionId || (e.entryType === 'first-input' ? 'first-input' : 0);
      if (!key) return;
      var k = sliceOfInteraction(e);
      var b = inpBuckets[k];
      if (b[key] === undefined || e.duration > b[key]) b[key] = e.duration;
      if (e.navigationId === undefined) idAgreement.noNavigationId++;
      else if (e.navigationId === list[k].navigationId) idAgreement.agree++;
      else idAgreement.disagree++;
    });

    var fcpHard = null;
    store.paint.forEach(function (p) { if (p.name === 'first-contentful-paint') fcpHard = p.startTime; });
    var lcpHard = store.lcp.length ? store.lcp[store.lcp.length - 1] : null;

    return list.map(function (s, i) {
      var worst = null;
      for (var k in inpBuckets[i]) if (worst === null || inpBuckets[i][k] > worst) worst = inpBuckets[i][k];
      var vitals = {};
      var lcpEntry = null;
      if (s.navigationType === 'hard') {
        vitals.ttfb = nav ? { value: nav.responseStart, status: 'ok' } : { value: null, status: 'not-finalized' };
        vitals.fcp = fcpHard !== null ? { value: fcpHard, status: 'ok' } : { value: null, status: 'not-finalized' };
        vitals.lcp = lcpHard ? { value: lcpHard.startTime, status: 'ok' } : { value: null, status: 'not-finalized' };
      } else {
        // TTFB is not carried on a soft Navigation: there is no document request.
        var paintAt = s.entry.presentationTime || s.entry.paintTime;
        vitals.fcp = paintAt ? { value: paintAt - s.start, status: 'ok' } : { value: null, status: 'not-finalized' };
        try {
          lcpEntry = typeof s.entry.getLargestInteractionContentfulPaint === 'function'
            ? s.entry.getLargestInteractionContentfulPaint() : null;
        } catch (x) {}
        if (!lcpEntry) {
          store.icp.forEach(function (c) {
            if (c.interactionId === s.interactionId && (!lcpEntry || c.size >= lcpEntry.size)) lcpEntry = c;
          });
        }
        // An ICP entry's own startTime is the INTERACTION's; the paint is in its nested
        // largestContentfulPaint (renderTime, else startTime), or startTime + duration.
        var inner = lcpEntry && lcpEntry.largestContentfulPaint;
        var lcpAt = inner ? (inner.renderTime || inner.startTime)
          : (lcpEntry ? lcpEntry.startTime + lcpEntry.duration : null);
        vitals.lcp = lcpAt ? { value: lcpAt - s.start, status: 'ok' } : { value: null, status: 'not-finalized' };
      }
      vitals.cls = has('layout-shift') ? { value: clsOf(shiftBuckets[i]), status: 'ok' } : { value: null, status: 'unsupported' };
      vitals.inp = worst !== null ? { value: worst, status: 'ok' } : { value: null, status: 'no-interaction' };
      return {
        navigationType: s.navigationType,
        ts: Math.round(performance.timeOrigin + s.start),
        startMs: s.start,
        url: s.url,
        navigationId: s.navigationId,
        interactionId: s.interactionId,
        vitals: vitals,
        lcpEntry: lcpEntry ? plain(lcpEntry) : null,
        lcpInner: lcpEntry && lcpEntry.largestContentfulPaint ? plain(lcpEntry.largestContentfulPaint) : null,
        shiftCount: shiftBuckets[i].length
      };
    });
  }

  window.__f1Flush = function () {
    return {
      userAgent: navigator.userAgent,
      softSupported: softSupported,
      icpSupported: has('interaction-contentful-paint'),
      // Interface names, for the record only: detection never depends on them.
      globals: { PerformanceSoftNavigation: typeof window.PerformanceSoftNavigation,
                 SoftNavigationEntry: typeof window.SoftNavigationEntry,
                 InteractionContentfulPaint: typeof window.InteractionContentfulPaint },
      supportedEntryTypes: supported,
      slices: slices(),
      eventNavigationIdVsTimeWindow: lastAgreement,
      raw: {
        softNavs: store.softNavs.map(plain),
        icp: store.icp.map(plain),
        events: store.events.map(plain),
        shifts: store.shifts.map(plain)
      }
    };
  };
})();
