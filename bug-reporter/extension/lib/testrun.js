// Test Run integration. When the local Test Run console is running on this
// computer, the review screen offers to note the bug being filed as a test
// scenario there (a Finding), to be written up as a test case later.
// Only ever talks to 127.0.0.1; Test Run only accepts calls from its own page
// and from this extension.

export const DEFAULT_PORT = 5178;

export function testRunBase(settings) {
  const p = Number(settings?.testRun?.port) || DEFAULT_PORT;
  return `http://127.0.0.1:${p}`;
}

async function timedFetch(fetchImpl, url, opts, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetchImpl(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** { book, tab, cycle, ... } when Test Run is running and enabled, else null. Never throws. */
export async function testRunStatus(settings, { fetchImpl = fetch, timeoutMs = 600 } = {}) {
  if (settings?.testRun?.enabled === false) return null;
  try {
    const r = await timedFetch(fetchImpl, `${testRunBase(settings)}/api/status`, { headers: { 'X-Test-Run': '1' } }, timeoutMs);
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.ok && j.app === 'test-run' ? j : null;
  } catch {
    return null;
  }
}

/** "CMS Sign Off · CMS 2.20.1 · cycle v2.20.1" */
export function whereLabel(s) {
  if (!s) return '';
  const book = String(s.book || '').replace(/\.xlsx$/i, '');
  return [book, s.tab, s.cycle ? `cycle ${s.cycle}` : ''].filter(Boolean).join(' · ');
}

const clip = (v, n) => String(v ?? '').trim().slice(0, n);

/** What Test Run needs to note a filed bug as a scenario. */
export function buildBugNote({ title, filed, repo, draft, extra, module, pageUrl }) {
  return {
    title: clip(title, 300),
    number: filed?.number ?? '',
    url: clip(filed?.url, 500),
    repo: clip(repo, 200),
    description: clip(draft?.description, 2000),
    actual: clip(draft?.actual, 1500),
    expected: clip(draft?.expected, 1500),
    extra: clip(extra, 800),
    module: clip(module, 80),
    pageUrl: clip(pageUrl, 300),
  };
}

/** Sends the note; resolves { key, book, tab } or throws with a readable message. */
export async function noteBugInTestRun(settings, note, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  let r;
  try {
    r = await timedFetch(fetchImpl, `${testRunBase(settings)}/api/note-bug`, {
      method: 'POST',
      headers: { 'X-Test-Run': '1', 'content-type': 'application/json' },
      body: JSON.stringify(note),
    }, timeoutMs);
  } catch (e) {
    throw new Error(e?.name === 'AbortError' ? 'Test Run did not answer in time.' : 'Test Run is not running any more.');
  }
  let j = null;
  try {
    j = await r.json();
  } catch {
    j = null;
  }
  if (!r.ok || !j || !j.ok) throw new Error(j?.error || `Test Run answered ${r.status}.`);
  return { key: j.key, book: j.book, tab: j.tab };
}
