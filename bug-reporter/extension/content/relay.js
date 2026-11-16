// Runs in the extension's isolated world. Forwards events from net-hook.main.js
// to the service worker in small batches.
(() => {
  if (window.__egovBrRelay) return;
  window.__egovBrRelay = true;
  const queue = [];
  let timer = null;

  function flush() {
    timer = null;
    if (!queue.length) return;
    const events = queue.splice(0, queue.length);
    try {
      chrome.runtime.sendMessage({ type: 'net-events', events }).catch(() => {});
    } catch {
      // extension was reloaded; this page keeps working, capture stops until reload
    }
  }

  document.addEventListener('__egov_br_event', (e) => {
    try {
      queue.push(JSON.parse(e.detail));
    } catch {
      return;
    }
    if (queue.length >= 20) flush();
    else if (!timer) timer = setTimeout(flush, 250);
  });
  window.addEventListener('pagehide', flush);
})();
