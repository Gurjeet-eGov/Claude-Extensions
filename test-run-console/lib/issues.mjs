// Filling in a GitHub issue's title, state and priority for the Known issues list,
// with the owner's own `gh` login (the same one that keeps the gist up to date),
// through the GitHub client (lib/github.mjs: POST /graphql).
//
// Priority comes from the issue's project board ("Priority" field, when the gh
// token may read projects), else from a label such as "P1" or "priority: high".
import { findCommand, createGithub } from './github.mjs';

const FIELDS = 'title state labels(first: 20) { nodes { name } }';
const PROJECT = 'projectItems(first: 10) { nodes { fieldValueByName(name: "Priority") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }';
const query = (withProject) => `query($url: URI!) { resource(url: $url) { __typename ... on Issue { ${FIELDS}${withProject ? ` ${PROJECT}` : ''} } ... on PullRequest { ${FIELDS} } } }`;

/** Is this a github.com issue or pull request page? */
export function isGithubIssue(url) {
  return /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(issues|pull)\/\d+(?:[/?#].*)?$/i.test(String(url || ''));
}

/** A priority from a board value or the labels: "P1", "High", … ('' when none). */
export function priorityOf(board, labels = []) {
  if (board) return String(board).slice(0, 40);
  for (const l of labels) {
    const s = String(l);
    let m = /^\s*p\s*([0-4])\b/i.exec(s);
    if (m) return `P${m[1]}`;
    m = /priority\s*[:/\-–]?\s*(.+)$/i.exec(s);
    if (m) return m[1].trim().slice(0, 40);
    if (/^(critical|blocker|urgent|high|medium|low)$/i.test(s.trim())) return s.trim();
  }
  return '';
}

/** One GraphQL question: { body (GitHub's answer, or null), error (why it failed, '' when it didn't) }. Never throws. */
async function ask(gh, q, url, timeoutMs) {
  try {
    const body = await gh.graphql(q, { url }, { timeoutMs });
    return { body, error: '' };
  } catch (e) {
    return { body: null, error: String((e && e.message) || e || '').trim().split('\n').slice(-1)[0] };
  }
}

/**
 * { title, state: 'open'|'closed', labels, priority } for a GitHub issue link.
 * Throws a readable error (gh missing, not signed in, no access, not found).
 */
export async function githubIssue(url, { ghPath, github, timeoutMs = 15000 } = {}) {
  if (!github && !findCommand('gh', ghPath)) throw Object.assign(new Error('The GitHub CLI (gh) is not installed, so titles cannot be filled in. Type them here, or install gh and run: gh auth login'), { code: 'NO_GH' });
  const gh = github || createGithub({ ghPath });
  let r = await ask(gh, query(true), url, timeoutMs);
  let res = r.body && r.body.data && r.body.data.resource;
  if (!res) {
    // Reading project boards needs the read:project scope; ask again without them.
    r = await ask(gh, query(false), url, timeoutMs);
    res = r.body && r.body.data && r.body.data.resource;
  }
  if (!res || !res.title) {
    const why = (r.body && r.body.errors && r.body.errors[0] && r.body.errors[0].message) || r.error || 'GitHub did not return it.';
    throw Object.assign(new Error(/auth|login|token|credential/i.test(why) ? `gh is not signed in (${why}). Run: gh auth login` : why), { code: 'GH_FAILED' });
  }
  const labels = ((res.labels && res.labels.nodes) || []).map((l) => l.name).filter(Boolean);
  const board = ((res.projectItems && res.projectItems.nodes) || []).map((n) => n && n.fieldValueByName && n.fieldValueByName.name).find(Boolean) || '';
  return {
    title: String(res.title).slice(0, 300),
    state: /closed|merged/i.test(res.state) ? 'closed' : 'open',
    labels: labels.slice(0, 20),
    priority: priorityOf(board, labels),
  };
}
