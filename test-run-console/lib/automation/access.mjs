// Who may see and act on automated results. The fields live on each person in lib/team.mjs:
//   person.automationSuites  'all' | 'none' | [suite ids]   whose results they see (default 'all')
//   person.startRuns         boolean                         ▶ Run and ⤒ Import Results (default true for
//                                                            a tester; never for a viewer)
// The owner (the host at the laptop, or with the admin link) sees everything and may act.
// Seeing a run also needs its workbook: mayOpen(person, run.attach.book), checked by the caller.

const isOwner = (person) => !!person && person.role === 'owner';

/** May this person see this suite's results? */
export function canSeeSuite(person, suiteId) {
  if (!person) return false;
  if (isOwner(person)) return true;
  const v = person.automationSuites;
  if (v == null || v === 'all' || v === '') return true;
  if (v === 'none') return false;
  return Array.isArray(v) && v.includes(suiteId);
}

/** May this person import results, delete or move runs, and link suites? */
export function canAct(person) {
  if (!person) return false;
  if (isOwner(person)) return true;
  if (person.role !== 'tester') return false;
  return person.startRuns !== false;
}
