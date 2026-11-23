// net-hook.main.js wraps console.error from an inline script, so Chrome does not file the
// page's own errors under Bug Reporter; where inline scripts are refused it wraps it itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../extension/content/net-hook.main.js', import.meta.url), 'utf8');

/** Runs the hook in a stub page. runsInline: whether an appended <script> runs (CSP allows it). */
function page({ runsInline }) {
  const logged = [];
  const events = [];
  const context = {
    console: { error: (...a) => logged.push(a) },
    location: { href: 'https://example.org/app' },
    performance: { now: () => 0 },
    addEventListener() {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  };
  context.window = context;
  context.document = {
    dispatchEvent: (e) => events.push(JSON.parse(e.detail)),
    createElement: () => ({ textContent: '', remove() {} }),
    documentElement: {
      appendChild(s) {
        if (runsInline) vm.runInContext(s.textContent, context, { filename: 'https://example.org/app' });
      },
    },
  };
  vm.createContext(context);
  const original = context.console.error;
  vm.runInContext(SOURCE, context, { filename: 'chrome-extension://id/content/net-hook.main.js' });
  return { context, logged, events, original };
}

for (const runsInline of [true, false]) {
  test(`console.error is captured and still printed (${runsInline ? 'inline script allowed' : 'inline script blocked'})`, () => {
    const { context, logged, events, original } = page({ runsInline });
    assert.notEqual(context.console.error, original, 'console.error is wrapped');
    assert.equal('__egovBrConsoleSink' in context, false, 'no global left behind');
    context.console.error('Error fetching data:', 'AxiosError 401');
    assert.deepEqual(logged, [['Error fetching data:', 'AxiosError 401']], 'the page still sees its own log');
    const c = events.filter((e) => e.kind === 'console');
    assert.equal(c.length, 1);
    assert.equal(c[0].data.level, 'error');
    assert.equal(c[0].data.message, 'Error fetching data: AxiosError 401');
  });
}

test('the wrapper comes from the inline script when it is allowed', () => {
  const { context } = page({ runsInline: true });
  // The fallback is written as `function (...args)`; the inline one uses `arguments`.
  assert.match(String(context.console.error), /arguments/);
  assert.doesNotMatch(String(context.console.error), /\.\.\.args/);
});
