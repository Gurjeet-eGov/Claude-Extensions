// Registers Bug Reporter's dynamic content scripts without "Duplicate script ID" errors.
// Two things used to collide:
// - two syncs at once (installing or reloading the extension, enabling a site, a permission
//   being removed): both saw no script, both registered, and the second one failed;
// - Chrome still holding a script from before a reload or update that getRegisteredContentScripts
//   did not list yet.

/** A queue: the jobs given to it run one at a time, in order. A failed job doesn't stop the next. */
export function serial() {
  let chain = Promise.resolve();
  return (job) => {
    const run = chain.then(job, job);
    chain = run.catch(() => {});
    return run;
  };
}

/** Replaces our scripts with these ids by `scripts` (an empty list just removes them). */
export async function replaceScripts(ids, scripts) {
  const there = (await chrome.scripting.getRegisteredContentScripts({ ids }).catch(() => [])).map((s) => s.id);
  if (there.length) await chrome.scripting.unregisterContentScripts({ ids: there }).catch(() => {});
  if (!scripts.length) return;
  try {
    await chrome.scripting.registerContentScripts(scripts);
  } catch (e) {
    if (!/duplicate script id/i.test(String(e && e.message))) throw e;
    // Chrome still had one: remove each of ours on its own (ignoring "not there") and register again.
    for (const id of ids) await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
    await chrome.scripting.registerContentScripts(scripts);
  }
}
