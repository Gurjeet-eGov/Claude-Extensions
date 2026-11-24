// A stand-in for the GitHub CLI (`gh api ...`), for the tests and local previews:
// gists (Test Run's address), GraphQL issue lookups, and a small repository held
// in a JSON file (refs, commits with or without parents, trees, blobs, file
// contents by branch or commit, ref creation and forced moves, and starting a
// workflow), enough for Test Run's publishing. Nothing goes to GitHub. Every call
// is logged.
const fs = require('fs');
const crypto = require('crypto');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

module.exports = function fakeGh(cfg) {
  const args = process.argv.slice(2);
  const log = (o) => fs.appendFileSync(cfg.log, JSON.stringify(o) + '\n');
  const out = (o) => { process.stdout.write(typeof o === 'string' || Buffer.isBuffer(o) ? o : JSON.stringify(o)); process.exit(0); };
  const fail = (status, message) => { process.stdout.write(JSON.stringify({ message })); process.stderr.write(`gh: ${message} (HTTP ${status})\n`); process.exit(1); };
  if (args[0] !== 'api') fail(400, 'Only gh api is faked');

  let method = 'GET';
  let endpoint = '';
  const headers = [];
  const fields = {};
  let readsInput = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '-X') method = args[++i];
    else if (a === '-H') headers.push(args[++i]);
    else if (a === '-f' || a === '-F') { const [k, ...v] = args[++i].split('='); fields[k] = v.join('='); }
    else if (a === '--input') { readsInput = true; i++; }
    else if (!endpoint) endpoint = a;
  }

  const run = (input) => {
    const body = input ? JSON.parse(input) : null;
    // GraphQL issue lookups (Known issues)
    if (endpoint === 'graphql') {
      // -f query=… -f url=…, or a JSON body { query, variables: { url } } (POST /graphql --input -)
      const url = fields.url || (body && body.variables && body.variables.url) || '';
      const withProject = String(fields.query || (body && body.query) || '').includes('projectItems');
      log({ graphql: url, withProject });
      if (cfg.fail) fail(401, 'Bad credentials');
      const it = (cfg.issues || {})[url];
      if (!it) { process.stdout.write(JSON.stringify({ data: { resource: null }, errors: [{ message: 'Could not resolve to a Resource with the URL.' }] })); process.exit(1); }
      const resource = { __typename: 'Issue', title: it.title, state: it.state || 'OPEN', labels: { nodes: (it.labels || []).map((name) => ({ name })) } };
      if (withProject) resource.projectItems = { nodes: it.priority ? [{ fieldValueByName: { name: it.priority } }] : [] };
      out({ data: { resource } });
    }
    // Gists (where the shared Test Run is)
    if (/^gists(\/|$)/.test(endpoint)) {
      log({ args, body });
      if (cfg.fail) fail(401, 'Bad credentials');
      out({ id: cfg.id });
    }
    // The repository
    const m = /^repos\/([^/]+)\/([^/?]+)(\/.*)?$/.exec(endpoint);
    if (!m) fail(404, 'Not Found');
    if (cfg.fail) fail(401, 'Bad credentials');
    const state = JSON.parse(fs.readFileSync(cfg.repo, 'utf8'));
    const save = () => fs.writeFileSync(cfg.repo, JSON.stringify(state));
    const rest = m[3] || '';
    log({ repo: method + ' ' + rest.replace(/\?.*$/, '') });
    if (!rest) out({ default_branch: state.branch, private: false, html_url: `https://github.com/${m[1]}/${m[2]}` });
    let r;
    if ((r = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && method === 'GET') {
      const sha = state.refs[decodeURIComponent(r[1])];
      if (!sha) fail(404, 'Not Found');
      out({ object: { sha, type: 'commit' } });
    }
    if ((r = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest)) && method === 'GET') {
      const c = state.commits[r[1]];
      if (!c) fail(404, 'Not Found');
      out({ sha: r[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message });
    }
    if ((r = /^\/git\/trees\/([0-9a-f]+)/.exec(rest)) && method === 'GET') {
      const t = state.trees[r[1]];
      if (!t) fail(404, 'Not Found');
      out({ sha: r[1], truncated: false, tree: Object.keys(t).map((path) => ({ path, mode: '100644', type: 'blob', sha: t[path] })) });
    }
    if (rest === '/git/blobs' && method === 'POST') {
      const buf = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8');
      const sha = blobSha(buf);
      state.blobs[sha] = buf.toString('base64');
      save();
      out({ sha });
    }
    if (rest === '/git/trees' && method === 'POST') {
      const t = Object.assign({}, state.trees[body.base_tree] || {});
      for (const e of body.tree) { if (e.sha === null) delete t[e.path]; else t[e.path] = e.sha; }
      const sha = sha1(JSON.stringify(t));
      state.trees[sha] = t;
      save();
      out({ sha });
    }
    if (rest === '/git/commits' && method === 'POST') {
      const sha = sha1(JSON.stringify(body) + Math.random());
      state.commits[sha] = { tree: body.tree, parents: body.parents || [], message: body.message };
      if (cfg.raceReplaceOnce && !state.raced) {
        // another Test Run replaces the branch while this commit is being made
        state.raced = true;
        const index = Buffer.from(JSON.stringify({ app: 'test-run', id: 'someone-else', publishedAt: '2026-11-24 09:00', by: 'Someone Else', workbooks: [] }));
        state.blobs[blobSha(index)] = index.toString('base64');
        const t = { 'reports/index.json': blobSha(index) };
        const tsha = sha1(JSON.stringify(t));
        state.trees[tsha] = t;
        const csha = sha1('race-replace' + Math.random());
        state.commits[csha] = { tree: tsha, parents: [], message: 'Someone else published' };
        state.refs[cfg.raceReplaceOnce] = csha;
      }
      save();
      out({ sha });
    }
    if (rest === '/git/refs' && method === 'POST') {
      const branch = String(body.ref || '').replace(/^refs\/heads\//, '');
      if (state.refs[branch]) fail(422, 'Reference already exists');
      if (!state.commits[body.sha]) fail(422, 'Object does not exist');
      state.refs[branch] = body.sha;
      save();
      out({ ref: body.ref, object: { sha: body.sha, type: 'commit' } });
    }
    if ((r = /^\/actions\/workflows\/([^/]+)\/dispatches$/.exec(rest)) && method === 'POST') {
      log({ dispatch: decodeURIComponent(r[1]), body });
      if (cfg.failDispatch) fail(403, 'Resource not accessible by integration');
      out(''); // 204 No Content
    }
    if ((r = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === 'PATCH') {
      const branch = decodeURIComponent(r[1]);
      if (body.force) {
        // a forced move: any commit, the old tip need not be its parent
        if (!state.refs[branch]) fail(422, 'Reference does not exist');
        if (!state.commits[body.sha]) fail(422, 'Object does not exist');
        state.refs[branch] = body.sha;
        save();
        out({ object: { sha: body.sha } });
      }
      if (cfg.raceOnce && !state.raced) {
        // someone else pushed just before us
        state.raced = true;
        const tip = state.refs[branch];
        const t = Object.assign({}, state.trees[state.commits[tip].tree], { 'OTHER.md': blobSha(Buffer.from('other')) });
        state.blobs[blobSha(Buffer.from('other'))] = Buffer.from('other').toString('base64');
        const tsha = sha1(JSON.stringify(t));
        state.trees[tsha] = t;
        const csha = sha1('race' + tip);
        state.commits[csha] = { tree: tsha, parents: [tip], message: 'Someone else' };
        state.refs[branch] = csha;
        save();
      }
      const c = state.commits[body.sha];
      if (!c || c.parents[0] !== state.refs[branch]) fail(422, 'Update is not a fast forward');
      state.refs[branch] = body.sha;
      save();
      out({ object: { sha: body.sha } });
    }
    if ((r = /^\/contents\/([^?]+)(?:\?ref=(.*))?$/.exec(rest)) && method === 'GET') {
      const path = r[1].split('/').map(decodeURIComponent).join('/');
      const ref = decodeURIComponent(r[2] || state.branch);
      const tip = state.refs[ref] || (state.commits[ref] ? ref : null); // a branch, or a commit id
      const sha = tip && state.trees[state.commits[tip].tree][path];
      if (!sha) fail(404, 'Not Found');
      const buf = Buffer.from(state.blobs[sha], 'base64');
      if (headers.some((h) => /vnd\.github\.raw/.test(h))) out(buf);
      out({ path, sha, encoding: 'base64', content: buf.toString('base64') });
    }
    fail(404, `Not faked: ${method} ${rest}`);
  };

  if (readsInput) {
    let input = '';
    process.stdin.on('data', (c) => { input += c; });
    process.stdin.on('end', () => run(input));
  } else {
    run('');
  }
};

/** A new repository state: one commit on the default branch with the given files ({ path: text }). */
module.exports.initialState = function initialState(files = { 'README.md': '# Repo\n' }, branch = 'master') {
  const blobs = {};
  const tree = {};
  for (const [path, text] of Object.entries(files)) {
    const buf = Buffer.from(text);
    const sha = blobSha(buf);
    blobs[sha] = buf.toString('base64');
    tree[path] = sha;
  }
  const tsha = sha1(JSON.stringify(tree));
  const csha = sha1('initial');
  return { branch, refs: { [branch]: csha }, commits: { [csha]: { tree: tsha, parents: [], message: 'Initial commit' } }, trees: { [tsha]: tree }, blobs };
};

/**
 * The files on a branch now (the default branch unless named): { files: { path: Buffer }, commits
 * (all commits in the repository), history (the commits reachable from the branch), sha, parents,
 * message }, or null when there is no such branch.
 */
module.exports.readFiles = function readFiles(stateFile, branch) {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const tip = state.refs[branch || state.branch];
  if (!tip) return null;
  const t = state.trees[state.commits[tip].tree];
  const out = {};
  for (const [path, sha] of Object.entries(t)) out[path] = Buffer.from(state.blobs[sha], 'base64');
  const seen = new Set();
  const walk = [tip];
  while (walk.length) { const c = walk.pop(); if (seen.has(c) || !state.commits[c]) continue; seen.add(c); walk.push(...state.commits[c].parents); }
  return { files: out, commits: Object.keys(state.commits).length, history: seen.size, sha: tip, parents: state.commits[tip].parents, message: state.commits[tip].message };
};
