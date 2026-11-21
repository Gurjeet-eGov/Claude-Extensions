import test from 'node:test';
import assert from 'node:assert/strict';

import { countBoardAssignees, parseIssueRef, interpretIssue } from '../host/lib/board.mjs';
import { buildCommentPrompt, parseClaudeOutput } from '../host/lib/claude.mjs';
import { buildComment, resultLine } from '../extension/lib/comment.js';
import { assigneeGroups, assigneeOptionsHtml } from '../extension/lib/people.js';

test('board assignees: counted per item, sorted by count then login', () => {
  const item = (...logins) => ({ content: { assignees: { nodes: logins.map((login) => ({ login })) } } });
  const r = countBoardAssignees([item('b', 'a'), item('a'), item('c'), item(), { content: null }, item('a', 'a')]);
  assert.deepEqual(r, [{ login: 'a', count: 3 }, { login: 'b', count: 1 }, { login: 'c', count: 1 }]);
});

test('assignee dropdown: board people first, the rest A–Z, Unassigned last, default selected', () => {
  const assignees = [{ login: 'zed', name: 'Zed' }, { login: 'dev-john-doe', name: 'John Doe' }, { login: 'amy', name: '' }, { login: 'Dev-Hari', name: 'Hari' }];
  const g = assigneeGroups({ assignees, boardAssignees: [{ login: 'dev-john-doe', count: 33 }, { login: 'dev-hari', count: 27 }, { login: 'left-org', count: 2 }] });
  assert.deepEqual(g.onBoard.map((p) => p.login), ['dev-john-doe', 'Dev-Hari']); // not-assignable people are dropped
  assert.deepEqual(g.others.map((p) => p.login), ['amy', 'zed']);
  const html = assigneeOptionsHtml({ assignees, boardAssignees: [{ login: 'dev-john-doe', count: 33 }], repo: 'o/r', selected: 'dev-john-doe' });
  assert.match(html, /<optgroup label="On this board"><option value="dev-john-doe" selected>John Doe \(dev-john-doe\) · 33 items<\/option>/);
  assert.match(html, /<optgroup label="Everyone who can be assigned in o\/r">/);
  assert.match(html, /<option value="" >Unassigned<\/option>$/);
  assert.match(assigneeOptionsHtml({ assignees, selected: '' }), /<option value="" selected>Unassigned/);
});

test('issue reference parsing', () => {
  assert.equal(parseIssueRef('215', 'eGov-Global/CMS-KENYA'), 215);
  assert.equal(parseIssueRef(' #215 ', 'eGov-Global/CMS-KENYA'), 215);
  assert.equal(parseIssueRef('https://github.com/eGov-Global/CMS-KENYA/issues/215#issuecomment-1', 'egov-global/cms-kenya'), 215);
  assert.throws(() => parseIssueRef('https://github.com/eGov-Global/CMS-MOZAMBIQUE/issues/5', 'eGov-Global/CMS-KENYA'), /CMS-MOZAMBIQUE/);
  assert.throws(() => parseIssueRef('abc', 'o/r'), /issue number/);
});

test('issue interpretation finds the item and Status on this board only', () => {
  const issue = {
    id: 'I_1', number: 215, title: 'T', state: 'OPEN', stateReason: null, url: 'u',
    assignees: { nodes: [{ login: 'me' }] },
    projectItems: { nodes: [
      { id: 'PVTI_other', project: { id: 'PVT_other' }, fieldValueByName: { name: 'Done', optionId: 'x' } },
      { id: 'PVTI_mine', project: { id: 'PVT_mine' }, fieldValueByName: { name: 'In Review', optionId: 'ae' } },
    ] },
  };
  const i = interpretIssue(issue, 'PVT_mine');
  assert.equal(i.boardItemId, 'PVTI_mine');
  assert.deepEqual(i.status, { name: 'In Review', optionId: 'ae' });
  assert.equal(interpretIssue(issue, 'PVT_none').boardItemId, null);
  assert.equal(interpretIssue(null, 'x'), null);
});

test('comment body: result line, comment, then evidence sections', () => {
  assert.equal(resultLine('fixed', 'Bomet'), '✅ **Verified fixed** on Bomet');
  assert.equal(resultLine('failing', ''), '❌ **Still failing**');
  assert.equal(resultLine('', 'Bomet'), '');
  const { body } = buildComment({
    result: 'partial',
    envPrefix: 'Bomet',
    comment: 'Assign works, but the SMS is still missing.',
    apiCalls: [{ method: 'POST', url: 'https://x/pgr/_update', status: 200, resBody: '{"ok":true}' }],
    screenshots: ['snapshot-1.png'],
    video: 'recording.mp4',
  });
  assert.match(body, /^⚠️ \*\*Partly fixed\*\* on Bomet\n\nAssign works, but the SMS is still missing\.\n\n### API Details\n/);
  assert.doesNotMatch(body, /### Description/);
  assert.match(body, /### Screenshots\n!\[Screenshot 1\]\(\.\/snapshot-1\.png\)/);
  assert.match(body, /### Screen Recording\n!\[\]\(\.\/recording\.mp4\)/);
});

test('polish prompt and parsing', () => {
  const p = buildCommentPrompt({ projectTitle: 'B', issue: { number: 215, title: 'Bar', state: 'OPEN' }, result: 'Verified fixed', notes: 'works', detail: 'concise' });
  assert.match(p, /^Task: update comment/);
  assert.match(p, /Issue: #215 "Bar" \(open\)/);
  assert.match(p, /Detail level: concise/);
  const r = parseClaudeOutput(JSON.stringify({ is_error: false, result: '{"comment":"Re-tested. Works."}', modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10, outputTokens: 20 } } }), 'comment');
  assert.deepEqual(r.draft, { comment: 'Re-tested. Works.' });
});
