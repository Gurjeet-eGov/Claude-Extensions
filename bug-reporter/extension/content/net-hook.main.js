// Runs in the PAGE's world (MAIN) on sites you enabled. Wraps fetch and
// XMLHttpRequest, and listens for console errors, without changing what the
// page sees. Events go to the extension's relay script as DOM CustomEvents.
(() => {
  if (window.__egovBugReporterHooked) return;
  try {
    Object.defineProperty(window, '__egovBugReporterHooked', { value: true });
  } catch {
    return;
  }

  const EVT = '__egov_br_event';
  const MAX_BODY = 256 * 1024;
  const MAX_CONSOLE_PER_SEC = 30;
  let seq = 0;

  const emit = (kind, data) => {
    try {
      document.dispatchEvent(new CustomEvent(EVT, { detail: JSON.stringify({ kind, data }) }));
    } catch {}
  };
  const newId = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const isTextual = (ct) => !ct || /json|text|xml|javascript|x-www-form-urlencoded|graphql/i.test(ct);
  const cap = (s) => {
    if (typeof s !== 'string') return { text: s == null ? null : String(s), truncated: false };
    return s.length > MAX_BODY ? { text: s.slice(0, MAX_BODY), truncated: true } : { text: s, truncated: false };
  };
  const absUrl = (u) => {
    try {
      return new URL(String(u), location.href).href;
    } catch {
      return String(u);
    }
  };

  function headersToObj(h) {
    const o = {};
    if (!h) return o;
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach((v, k) => (o[k] = v));
      else if (Array.isArray(h)) for (const [k, v] of h) o[k] = String(v);
      else for (const k of Object.keys(h)) o[k] = String(h[k]);
    } catch {}
    return o;
  }

  function parseRawHeaders(raw) {
    const o = {};
    for (const line of String(raw || '').trim().split(/[\r\n]+/)) {
      const i = line.indexOf(':');
      if (i > 0) o[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return o;
  }

  async function describeBody(body) {
    try {
      if (body == null) return { kind: 'none' };
      if (typeof body === 'string') {
        const c = cap(body);
        return { kind: 'text', text: c.text, truncated: c.truncated };
      }
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return { kind: 'text', text: body.toString() };
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const entries = [];
        for (const [name, v] of body.entries()) {
          entries.push(typeof v === 'string' ? { name, value: v.slice(0, 4000) } : { name, file: { name: v.name, type: v.type, size: v.size } });
        }
        return { kind: 'formdata', entries };
      }
      if (typeof Blob !== 'undefined' && body instanceof Blob) {
        if (isTextual(body.type) && body.size <= MAX_BODY) return { kind: 'text', text: await body.text() };
        return { kind: 'binary', text: `<binary ${body.type || 'data'}, ${body.size} bytes, not captured>` };
      }
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        return { kind: 'binary', text: `<binary ${body.byteLength} bytes, not captured>` };
      }
      if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return { kind: 'binary', text: '<stream body, not captured>' };
      return { kind: 'text', text: String(body) };
    } catch {
      return { kind: 'none' };
    }
  }

  function report(base, b, extra) {
    emit('call', {
      id: base.id,
      kind: base.kind,
      ts: base.started,
      duration: Math.round(performance.now() - base.t0),
      method: base.method,
      url: base.url,
      pageUrl: location.href,
      reqHeaders: base.reqHeaders,
      reqBody: b.kind === 'formdata' || b.kind === 'none' ? null : b.text,
      reqBodyKind: b.kind,
      reqBodyTruncated: Boolean(b.truncated),
      reqFormData: b.kind === 'formdata' ? b.entries : undefined,
      ...extra,
    });
  }

  // ---------- fetch ----------
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    const wrapped = function fetch(input, init) {
      const base = { id: newId(), kind: 'fetch', started: Date.now(), t0: performance.now() };
      let req = null;
      try {
        if (typeof Request !== 'undefined' && input instanceof Request) req = input;
      } catch {}
      base.url = absUrl(req ? req.url : input);
      base.method = String((init && init.method) || (req && req.method) || 'GET').toUpperCase();
      base.reqHeaders = Object.assign(req ? headersToObj(req.headers) : {}, headersToObj(init && init.headers));
      let bodyP;
      try {
        if (init && init.body != null) bodyP = describeBody(init.body);
        else if (req && !req.bodyUsed && base.method !== 'GET' && base.method !== 'HEAD') bodyP = req.clone().text().then(describeBody);
      } catch {}
      bodyP = (bodyP || Promise.resolve({ kind: 'none' })).catch(() => ({ kind: 'none' }));

      const p = origFetch.apply(this, arguments);
      p.then(
        (res) => {
          let clone = null;
          let omitted = '';
          const ct = (res.headers && res.headers.get('content-type')) || '';
          try {
            if (res.type === 'opaque') omitted = 'opaque (no-cors) response';
            else if (isTextual(ct) && !/event-stream/i.test(ct)) clone = res.clone();
            else omitted = ct ? `content-type ${ct}` : 'non-text response';
          } catch {
            omitted = 'could not read';
          }
          const resHeaders = headersToObj(res.headers);
          Promise.all([bodyP, clone ? clone.text().catch(() => null) : Promise.resolve(null)]).then(([b, text]) => {
            const c = cap(text);
            report(base, b, {
              status: res.status,
              statusText: res.statusText,
              resHeaders,
              resBody: c.text,
              resBodyTruncated: c.truncated,
              resBodyOmitted: text == null && !omitted && clone ? 'could not read' : omitted,
            });
          });
        },
        (err) => {
          bodyP.then((b) =>
            report(base, b, {
              status: 0,
              statusText: '',
              error: String((err && err.message) || err),
              errorKind: err && err.name === 'AbortError' ? 'ABORTED' : 'NETWORK_ERROR',
            }),
          );
        },
      );
      return p;
    };
    try {
      Object.defineProperty(wrapped, 'name', { value: 'fetch' });
    } catch {}
    window.fetch = wrapped;
  }

  // ---------- XMLHttpRequest ----------
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    const setHeader = XHR.prototype.setRequestHeader;
    XHR.prototype.open = function (method, url) {
      try {
        this.__egovBr = { id: newId(), kind: 'xhr', method: String(method || 'GET').toUpperCase(), url: absUrl(url), reqHeaders: {} };
      } catch {}
      return open.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (k, v) {
      try {
        if (this.__egovBr) this.__egovBr.reqHeaders[k] = String(v);
      } catch {}
      return setHeader.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      const base = this.__egovBr;
      if (base) {
        base.started = Date.now();
        base.t0 = performance.now();
        const bodyP = describeBody(body);
        let errorKind = '';
        this.addEventListener('error', () => (errorKind = 'NETWORK_ERROR'));
        this.addEventListener('timeout', () => (errorKind = 'TIMEOUT'));
        this.addEventListener('abort', () => (errorKind = 'ABORTED'));
        this.addEventListener('loadend', () => {
          let resBody = null;
          let truncated = false;
          let omitted = '';
          try {
            const rt = this.responseType;
            if (rt === '' || rt === 'text') ({ text: resBody, truncated } = cap(this.responseText));
            else if (rt === 'json') ({ text: resBody, truncated } = cap(JSON.stringify(this.response)));
            else omitted = `responseType ${rt}`;
          } catch {
            omitted = 'could not read';
          }
          let resHeaders = {};
          try {
            resHeaders = parseRawHeaders(this.getAllResponseHeaders());
          } catch {}
          const status = this.status;
          const statusText = this.statusText;
          bodyP.then((b) =>
            report(base, b, {
              status,
              statusText,
              resHeaders,
              resBody,
              resBodyTruncated: truncated,
              resBodyOmitted: omitted,
              ...(errorKind ? { error: errorKind === 'NETWORK_ERROR' ? 'Network error (XHR)' : errorKind.toLowerCase(), errorKind } : {}),
            }),
          );
        });
      }
      return send.apply(this, arguments);
    };
  }

  // ---------- console errors ----------
  let windowStart = 0;
  let windowCount = 0;
  const fmt = (a) => {
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    if (typeof a === 'string') return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  function emitConsole(level, args, stack) {
    const now = Date.now();
    if (now - windowStart > 1000) {
      windowStart = now;
      windowCount = 0;
    }
    if (++windowCount > MAX_CONSOLE_PER_SEC) return;
    const err = args.find((a) => a instanceof Error);
    emit('console', {
      id: newId(),
      ts: now,
      level,
      message: args.map(fmt).join(' ').slice(0, 4000),
      stack: String(stack || (err && err.stack) || '').slice(0, 4000),
      pageUrl: location.href,
    });
  }
  const origError = console.error;
  console.error = function (...args) {
    try {
      emitConsole('error', args);
    } catch {}
    return origError.apply(this, args);
  };
  window.addEventListener('error', (e) => {
    try {
      if (typeof ErrorEvent !== 'undefined' && e instanceof ErrorEvent) {
        emitConsole('uncaught', [e.error || e.message], (e.error && e.error.stack) || (e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : ''));
      }
    } catch {}
  });
  window.addEventListener('unhandledrejection', (e) => {
    try {
      emitConsole('unhandledrejection', [e.reason]);
    } catch {}
  });
})();
