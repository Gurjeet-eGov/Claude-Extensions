// Pure helpers for reading a GitHub Projects v2 board. No I/O here, so they are unit-tested.

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

/** https://github.com/orgs/<org>/projects/<n>[/views/..] or https://github.com/users/<u>/projects/<n> */
export function parseBoardUrl(url) {
  const m = String(url || '').trim().match(/^https?:\/\/github\.com\/(orgs|users)\/([A-Za-z0-9-_.]+)\/projects\/(\d+)/i);
  if (!m) return null;
  return {
    ownerType: m[1].toLowerCase() === 'orgs' ? 'organization' : 'user',
    owner: m[2],
    number: Number(m[3]),
  };
}

export function parseRepo(repo) {
  const m = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').match(/^([A-Za-z0-9-_.]+)\/([A-Za-z0-9-_.]+)\/?$/);
  return m ? { owner: m[1], name: m[2], nameWithOwner: `${m[1]}/${m[2]}` } : null;
}

const PROJECT_FRAGMENT = `
  id title url
  repositories(first: 25) { nodes { nameWithOwner visibility } }
  fields(first: 50) {
    nodes {
      __typename
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField { id name options { id name } }
      ... on ProjectV2IterationField {
        id name
        configuration {
          iterations { id title startDate duration }
        }
      }
    }
  }`;

export function boardQuery(ownerType) {
  const root = ownerType === 'user' ? 'user' : 'organization';
  return `query($login: String!, $num: Int!) { ${root}(login: $login) { projectV2(number: $num) { ${PROJECT_FRAGMENT} } } }`;
}

export const ISSUE_FIELDS_QUERY = `query($login: String!) {
  organization(login: $login) {
    issueFields(first: 30) {
      nodes { __typename ... on IssueFieldSingleSelect { id name options { id name } } }
    }
  }
}`;

export const REPO_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner visibility
    labels(first: 100) { nodes { name } }
    assignableUsers(first: 100, after: $after) { nodes { login name } pageInfo { hasNextPage endCursor } }
  }
}`;

/**
 * Maps P0..P3 to the field's options.
 * 1) options literally named P0..P3, 2) Urgent/High/Medium/Low style words, 3) order, when there are exactly 4.
 */
export function defaultPriorityMapping(options = []) {
  const map = {};
  for (const p of PRIORITIES) {
    const o = options.find((x) => new RegExp(`(^|[^A-Za-z0-9])${p}([^0-9]|$)`, 'i').test(x.name));
    if (o) map[p] = { id: o.id, name: o.name };
  }
  if (Object.keys(map).length === 4) return map;

  const words = {
    P0: /urgent|critical|blocker|highest|showstopper/i,
    P1: /^(?!.*highest).*\bhigh\b/i,
    P2: /medium|normal|moderate/i,
    P3: /\blow\b|minor|lowest|trivial/i,
  };
  const byWord = {};
  for (const p of PRIORITIES) {
    const o = options.find((x) => words[p].test(x.name) && !Object.values(byWord).some((v) => v.id === x.id));
    if (o) byWord[p] = { id: o.id, name: o.name };
  }
  if (Object.keys(byWord).length === 4) return byWord;

  if (options.length === 4) {
    return Object.fromEntries(PRIORITIES.map((p, i) => [p, { id: options[i].id, name: options[i].name }]));
  }
  return { ...byWord, ...map };
}

/**
 * Turns the raw GraphQL project into what the extension needs.
 * @param {object} project   projectV2 node
 * @param {Array|null} issueFields  org issue fields (single-select nodes) or null
 */
export function interpretBoard(project, issueFields) {
  if (!project) throw new Error('Project not found, or your gh login cannot see it.');
  const fields = (project.fields?.nodes || []).filter(Boolean);
  const status = fields.find((f) => /^status$/i.test(f.name) && Array.isArray(f.options));
  const boardPriority = fields.find((f) => /^priority$/i.test(f.name) && Array.isArray(f.options) && f.options.length > 0);
  const iteration = fields.find((f) => f.configuration && Array.isArray(f.configuration.iterations));

  let priority;
  if (boardPriority) {
    priority = {
      mode: 'board',
      fieldId: boardPriority.id,
      fieldName: boardPriority.name,
      options: boardPriority.options,
      mapping: defaultPriorityMapping(boardPriority.options),
    };
  } else {
    const orgField = (issueFields || []).find((f) => f && /^priority$/i.test(f.name) && f.options?.length);
    priority = orgField
      ? { mode: 'issueField', fieldId: orgField.id, fieldName: orgField.name, options: orgField.options, mapping: defaultPriorityMapping(orgField.options) }
      : { mode: 'title' };
  }

  return {
    projectId: project.id,
    title: project.title,
    url: project.url,
    repos: (project.repositories?.nodes || []).filter(Boolean),
    status: status ? { fieldId: status.id, options: status.options } : null,
    priority,
    iteration: iteration
      ? { fieldId: iteration.id, name: iteration.name, iterations: iteration.configuration.iterations || [] }
      : null,
  };
}

export function findBacklogOption(statusOptions = []) {
  return statusOptions.find((o) => /^backlog$/i.test(o.name)) || statusOptions.find((o) => /backlog/i.test(o.name)) || null;
}

// ---------- people on the board ----------

export function boardItemsQuery(ownerType) {
  const root = ownerType === 'user' ? 'user' : 'organization';
  return `query($login: String!, $num: Int!, $after: String) {
  ${root}(login: $login) {
    projectV2(number: $num) {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { content { __typename
          ... on Issue { assignees(first: 10) { nodes { login } } }
          ... on PullRequest { assignees(first: 10) { nodes { login } } } } }
      }
    }
  }
}`;
}

/** [{login, count}] for everyone assigned to items on the board, most items first. */
export function countBoardAssignees(itemNodes = []) {
  const counts = new Map();
  for (const it of itemNodes) {
    const logins = new Set((it?.content?.assignees?.nodes || []).map((n) => n?.login).filter(Boolean));
    for (const l of logins) counts.set(l, (counts.get(l) || 0) + 1);
  }
  return [...counts.entries()].map(([login, count]) => ({ login, count })).sort((a, b) => b.count - a.count || a.login.localeCompare(b.login));
}

// ---------- existing issues (Update Issue) ----------

/**
 * "215", "#215" or "https://github.com/<owner>/<repo>/issues/215" → 215.
 * A link to another repository is rejected, so a comment can't land on the wrong project.
 */
export function parseIssueRef(input, repo) {
  const s = String(input || '').trim();
  const m = s.match(/^#?(\d{1,7})$/);
  if (m) return Number(m[1]);
  const u = s.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/i);
  if (u) {
    const linkRepo = `${u[1]}/${u[2]}`;
    if (repo && linkRepo.toLowerCase() !== String(repo).toLowerCase()) {
      throw Object.assign(new Error(`That link is for ${linkRepo}, but this project files into ${repo}.`), { code: 'BAD_INPUT' });
    }
    return Number(u[3]);
  }
  throw Object.assign(new Error('Enter an issue number (e.g. 215 or #215) or the issue link.'), { code: 'BAD_INPUT' });
}

export const ISSUE_QUERY = `query($owner: String!, $name: String!, $num: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $num) {
      id number title state stateReason url
      assignees(first: 10) { nodes { login } }
      projectItems(first: 20) {
        nodes {
          id
          project { id number }
          fieldValueByName(name: "Status") { __typename ... on ProjectV2ItemFieldSingleSelectValue { name optionId } }
        }
      }
    }
  }
}`;

/** The issue plus its item and Status on this board (null when it isn't on the board). */
export function interpretIssue(issue, projectId) {
  if (!issue) return null;
  const item = (issue.projectItems?.nodes || []).find((n) => n?.project?.id === projectId) || null;
  const sv = item?.fieldValueByName;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    state: issue.state, // OPEN | CLOSED
    stateReason: issue.stateReason,
    url: issue.url,
    assignees: (issue.assignees?.nodes || []).map((n) => n.login),
    boardItemId: item?.id || null,
    status: sv && sv.name ? { name: sv.name, optionId: sv.optionId } : null,
  };
}
