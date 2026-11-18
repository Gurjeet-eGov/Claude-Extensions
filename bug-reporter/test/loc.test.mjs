import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The rules file is a classic script (content script) that defines globalThis.EgovLocRules.
const sandbox = {};
vm.runInNewContext(readFileSync(new URL('../extension/content/loc-rules.js', import.meta.url), 'utf8'), { globalThis: sandbox, URL });
const R = sandbox.EgovLocRules;

test('flags the 12 raw keys and tenant codes from the rules doc', () => {
  const cases = [
    ['CS_COMMON_SUBMIT', ['CS_COMMON_SUBMIT']],
    ['CS_COMMON_NA', ['CS_COMMON_NA']],
    ['DSS_W&S_TOTAL_COLLECTION', ['DSS_W&S_TOTAL_COLLECTION']],
    ['DSS_TB_PT (In Lac)', ['DSS_TB_PT']],
    ['DSS_FROM Apr, 01 2026 DSS_TO Aug, 04 2026', ['DSS_FROM', 'DSS_TO']],
    ['Azad Nagar - WARD_1', ['WARD_1']],
    ['DSS_TB_City', ['DSS_TB_City']],
    ['DSS_TB_DDRS : Amritsar-DDR', ['DSS_TB_DDRS']],
    ['COMMON_MASTERS_DEPARTMENT_DEPT_1', ['COMMON_MASTERS_DEPARTMENT_DEPT_1']],
    ['pb.testing', ['pb.testing']],
    ['pb.amritsar', ['pb.amritsar']],
    ['ke.bomet', ['ke.bomet']],
  ];
  for (const [text, codes] of cases) assert.deepEqual([...R.findCodes(text)], codes, text);
});

test('does not flag the 21 look-alikes from the rules doc', () => {
  const clean = [
    'arrow_drop_down', 'expand_more', 'Azad_Nagar', 'A_B', 'e.g.', 'Rs.100', 'user@mail.com', 'www.digit.org',
    'nairobi.go.ke', '1,234.50', '45.5%', '16.11.2026', 'PGR-2026-11-16-001234', 'Submit', 'SUBMIT', 'Powered by',
    'Enter House No.', 'Ward No.', 'WARD 1', 'Select Kaunti Ndogo', 'Request failed with status code 413',
  ];
  assert.equal(clean.length, 21);
  for (const text of clean) assert.deepEqual([...R.findCodes(text)], [], text);
});

test('text is split on newlines and tabs, not spaces', () => {
  assert.deepEqual([...R.splitText('  CS_A_B \n\tHello world\t\tke.bomet\n')], ['CS_A_B', 'Hello world', 'ke.bomet']);
  assert.deepEqual([...R.findCodesInText('Status\nCS_COMMON_SUBMIT\tpb.testing\nWard No.')], ['CS_COMMON_SUBMIT', 'pb.testing']);
  // a tenant code inside a sentence is not a whole-string match
  assert.deepEqual([...R.findCodesInText('Tenant is ke.bomet today')], []);
});

test('page path and file name', () => {
  assert.equal(R.pagePath('https://bgrm.bomet.go.ke/digit-ui/employee/pgr/inbox-v2'), 'digit-ui/employee/pgr/inbox-v2');
  assert.equal(R.pagePath('https://bgrm.bomet.go.ke/digit-ui/employee/pgr/inbox-v2/?tenantId=ke#top'), 'digit-ui/employee/pgr/inbox-v2');
  assert.equal(R.pagePath('https://x.org/'), '/');
  assert.equal(R.fileBaseForHost('bgrm.bomet.go.ke'), 'bgrm_bomet_go_ke');
  assert.equal(R.fileBaseForHost('localhost:8787'), 'localhost');
});

test('CSV: BOM, Code/Page header, sorted, quoted when needed', () => {
  const csv = R.toCsv([
    { code: 'CS_B', page: 'digit-ui/employee/pgr/inbox-v2' },
    { code: 'CS_A', page: 'digit-ui/employee/pgr/inbox-v2' },
    { code: 'DSS_FROM', page: 'a,b' },
  ]);
  assert.equal(csv, '﻿Code,Page\r\nDSS_FROM,"a,b"\r\nCS_A,digit-ui/employee/pgr/inbox-v2\r\nCS_B,digit-ui/employee/pgr/inbox-v2\r\n');
});
