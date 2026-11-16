// Track Localizations: while tracking is on, finds raw localization keys / tenant codes
// on the page and sends each new (code, page) pair to the service worker.
//
// - A full scan when the page loads (or tracking starts) covers everything already in the
//   page, including hidden content such as a dropdown's options before it is opened.
// - A MutationObserver then checks anything that appears later: custom dropdowns, expanded
//   rows, drill-down tables, modals, toasts, and the next page of a single-page app.
// - Only new (code, page) pairs are sent, so long sessions stay small.
// Needs content/loc-rules.js loaded first (defines EgovLocRules).
(() => {
  if (window.__egovLocTracker) return;
  window.__egovLocTracker = true;
  const R = globalThis.EgovLocRules;
  if (!R) return;

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'CANVAS']);
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'label', 'data-tip'];
  const sent = new Set(); // `${page}\u0000${code}` already reported from this page load
  let queue = [];
  let active = false;
  let observer = null;
  let flushTimer = null;
  let pendingNodes = new Set();
  let processTimer = null;
  let lastHref = location.href;

  function report(code) {
    const page = R.pagePath(location.href);
    const key = `${page}\u0000${code}`;
    if (sent.has(key)) return;
    sent.add(key);
    queue.push({ code, page });
    if (!flushTimer) flushTimer = setTimeout(flush, 800);
  }

  function flush() {
    flushTimer = null;
    if (!queue.length) return;
    const items = queue.splice(0, queue.length);
    try {
      chrome.runtime.sendMessage({ type: 'loc-found', host: location.host, items }).catch(() => {});
    } catch {
      // extension reloaded: stop quietly
      stop();
    }
  }

  function checkText(text) {
    if (!text || text.length < 3) return;
    for (const code of R.findCodesInText(text)) report(code);
  }

  function checkElementAttrs(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) checkText(v);
    }
    // button-like inputs show their value as text
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) && el.value) checkText(el.value);
  }

  /** Every text node and labelled attribute under `root`, hidden ones included. */
  function scan(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) return checkText(root.nodeValue);
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) {
      if (SKIP.has(root.tagName)) return;
      checkElementAttrs(root);
      if (root.shadowRoot) {
        scan(root.shadowRoot);
        watch(root.shadowRoot);
      }
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && SKIP.has(n.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let n = walker.nextNode();
    while (n) {
      if (n.nodeType === Node.TEXT_NODE) checkText(n.nodeValue);
      else {
        checkElementAttrs(n);
        if (n.shadowRoot) {
          scan(n.shadowRoot);
          watch(n.shadowRoot);
        }
      }
      n = walker.nextNode();
    }
  }

  function fullScan() {
    scan(document.body || document.documentElement);
    // the tab title can show a key too
    checkText(document.title);
  }

  function processPending() {
    processTimer = null;
    if (!active) return;
    if (location.href !== lastHref) {
      // single-page app moved to another page: check the whole new page
      lastHref = location.href;
      pendingNodes.clear();
      fullScan();
      return;
    }
    const nodes = [...pendingNodes];
    pendingNodes.clear();
    for (const n of nodes) if (n.isConnected) scan(n);
  }

  function onMutations(records) {
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach((n) => pendingNodes.add(n));
      else if (r.type === 'characterData') pendingNodes.add(r.target);
      else if (r.type === 'attributes') pendingNodes.add(r.target);
    }
    if (!processTimer) processTimer = setTimeout(processPending, 400);
  }

  const watched = new WeakSet();
  function watch(target) {
    if (!observer || !target || watched.has(target)) return;
    watched.add(target);
    observer.observe(target, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat(['value']) });
  }

  function start() {
    if (active) return;
    active = true;
    lastHref = location.href;
    observer = new MutationObserver(onMutations);
    watch(document.documentElement);
    fullScan();
  }

  function stop() {
    active = false;
    observer?.disconnect();
    observer = null;
    flush();
  }

  // Page changes without DOM changes (rare) and back/forward in single-page apps.
  setInterval(() => {
    if (active && location.href !== lastHref && !processTimer) processTimer = setTimeout(processPending, 50);
  }, 1000);
  window.addEventListener('pagehide', flush);

  chrome.storage.local.get('locTracking').then(({ locTracking }) => {
    if (locTracking?.active) start();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.locTracking) return;
    const now = changes.locTracking.newValue;
    if (now?.active) {
      if (now.sessionId !== changes.locTracking.oldValue?.sessionId) {
        sent.clear(); // a new list
        if (active) fullScan();
      }
      start();
    } else stop();
  });
})();
