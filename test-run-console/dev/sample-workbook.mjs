// Sample workbook for the unit tests and the local demo.
// The header rows copy the layouts of the real CMS sign-off workbook (two
// manual layouts and the KPI tab). Every case below is made up for testing;
// none is copied from a real sheet.
import ExcelJS from 'exceljs';
import { FakeSpreadsheet } from './fake-sheets.mjs';

const B = (...lines) => lines.map((l) => `• ${l}`).join('\n');

export const MANUAL_HEADERS = ['S .No', 'Scenario', 'Sub feature', 'Test Type', 'Test Data', 'Pre Condition', 'Expected result', 'Test Status / v2.12', 'Comment / v2.12'];
export const FEATURE_HEADERS = ['S .No', 'Scenario', 'Feature', 'Sub feature', 'Test Type', 'Test Data', 'Pre Condition', 'Expected result', 'Test Status / v2.20', 'Comment / v2.20', 'Linked issue'];
export const KPI_HEADERS = ['KPI', 'Definition', 'Formula', 'Status', 'Notes'];

const STATUS = ['Fail', 'NA (Skipped)', 'Pass'];

const manualRows = [
  ['CMS/01', 'Verify if the CSR sees Create and Search complaint in the left menu', 'CSR Employee', 'UI', '', 'Logged in as CSR', B('Create complaint and Search complaint shall be listed in the left menu'), 'Pass', ''],
  ['CMS/02', 'Verify if the Create Complaint form fields are aligned and labelled', '', 'UI', '', 'Logged in as CSR', B('All fields shall have visible labels', 'Mandatory fields shall be marked with *'), 'Pass', ''],
  ['CMS/03', 'Verify if the CSR is able to create a complaint with all valid inputs', '', 'Functional', 'Valid mobile, name, type, sub-type, locality', 'Logged in as CSR', B('Complaint shall be created and a complaint number shown', 'Complaint shall appear in the inbox as PENDINGFORASSIGNMENT'), 'Pass', ''],
  ['CMS/04', 'Verify if the CSR is able to create a complaint with only mandatory fields', '', 'Validation', 'Complainant phone, name, complaint type, sub-type', 'Logged in as CSR', B('Complaint shall be created', 'Skipping a mandatory field shall show a validation message'), '', ''],
  ['CMS/05', 'Verify if every boundary level is shown on complaint details', 'Complaint Details', 'Functional', '', 'Boundary has zone, ward and block levels', B('Zone, ward and block shall all be shown on the details page'), 'Fail', 'Block level missing on details page'],
  ['CMS/06', 'Verify if the employee can search complaints by complaint number and mobile', 'Search Complaint Employee', 'Functional', 'Valid and invalid numbers', 'Complaints exist', B('Matching complaints shall be listed', 'An unknown number shall show "No results"'), 'NA (Skipped)', 'inbox-search.spec (by number, by mobile) skipped on this deployment'],
  ['CMS/07', 'Verify if the employee can clear a search from the inbox', 'Search Complaint Employee', 'Functional', 'Partial complaint number', 'Search applied', B('Clear shall reset all filters and list every complaint'), '', 'Partly automated: inbox-search.spec'],
  ['CMS/08', 'Verify if the GRO is able to assign a complaint pending for assignment', 'Workflow', 'Functional', '', 'Complaint in PENDINGFORASSIGNMENT; GRO logged in', B('Complaint shall move to PENDINGATLME', 'Assigned LME shall be shown on the timeline'), '', ''],
  ['CMS/09', 'Verify if the GRO is able to reject a complaint with a reason', '', 'Functional', 'Reason: duplicate', 'Complaint in PENDINGFORASSIGNMENT; GRO logged in', B('Complaint shall move to REJECTED', 'Reason shall be shown on the timeline'), '', ''],
  ['CMS/10', 'Verify if the LME is able to resolve an assigned complaint with a photo', '', 'Functional', 'JPEG under 5 MB', 'Complaint in PENDINGATLME; LME logged in', B('Complaint shall move to RESOLVED', 'Photo shall be visible on the timeline'), '', ''],
  ['CMS/11', 'Verify that a resolution photo over the size limit is rejected', '', 'Validation', 'JPEG of 6 MB', 'Complaint in PENDINGATLME; LME logged in', B("'File is too large' shall be shown", 'Complaint shall stay in PENDINGATLME'), 'Fail', 'Generic error shown instead of the size message'],
  ['CMS/12', 'Verify if the timeline lists every action with actor and time', 'Timeline', 'UI', '', 'Complaint resolved', B('Each action shall show who did it and when'), '', ''],
  ['CMS/13', 'Verify if the citizen can rate a resolved complaint', 'Citizen UI', 'Functional', 'Rating 4, comment', 'Complaint RESOLVED; citizen logged in', B('Complaint shall move to CLOSEDAFTERRESOLUTION', 'Rating shall be shown on the timeline'), '', ''],
  ['CMS/14', 'Verify if the citizen can reopen a resolved complaint within the allowed days', '', 'Functional', '', 'Complaint RESOLVED less than 5 days ago', B('Complaint shall move to PENDINGFORASSIGNMENT', 'Reopen reason shall be on the timeline'), '', ''],
  ['CMS/15', 'Verify if an SMS is sent to the citizen when a complaint is created', 'SMS Notification', 'Functional', '', 'SMS templates configured', B('Citizen shall receive an SMS with the complaint number'), 'NA (Skipped)', 'No SMS gateway on this deployment'],
  ['CMS/16', 'Verify if complainant mobile numbers are masked for the LME', 'Encryption', 'Functional', '', 'LME logged in', B('Mobile number shall be masked except the last 4 digits'), '', ''],
  ['CMS/17', 'Verify if the inbox can be filtered by status and locality', 'Inbox', 'Functional', '', 'Complaints in several states', B('Only complaints matching both filters shall be listed'), 'Pass', ''],
  ['CMS/18', 'Verify if the inbox shows SLA days remaining for each complaint', '', 'UI', '', 'Complaints with SLA configured', B('SLA days shall be shown and turn red when breached'), '', ''],
];

const featureRows = [
  ['CMS/001', 'Verify if a new user is able to sign up with name and email', 'Self-serve sign-up', 'Configurator', 'Functional', 'An email not yet registered', 'Sign-up page open', B('Sign-in link shall be emailed', 'Link shall open the account step'), 'Pass', '', ''],
  ['CMS/002', 'Verify that the account code is validated for uniqueness', 'Self-serve sign-up', 'Configurator', 'Validation', 'An account name already in use', 'Email verified', B('A used code shall show "Already taken"'), 'Fail', 'Duplicate code accepted', '#812'],
  ['CMS/003', 'Verify if preferences default from the base country', 'Self-serve sign-up', 'Configurator', 'Functional', 'Base country India', 'Account step done', B('Timezone and mobile prefix shall default from the country'), '', '', ''],
  ['CMS/004', 'Verify that the founder mobile number is validated for the base country', 'Self-serve sign-up', 'Configurator', 'Validation', '9876543210 valid; 5876543210 invalid', 'Preferences step open', B('An invalid number shall show a validation message'), '', '', ''],
  ['CMS/005', 'Verify if a signed-in session expires after the idle timeout', 'Sign-in and session', 'Keycloak', 'Security', '', 'Signed in', B('After the timeout the user shall be asked to sign in again'), 'NA (Skipped)', 'Timeout set to 8h on this deployment', ''],
  ['CMS/006', 'Verify if a citizen can file a complaint over WhatsApp', 'WhatsApp complaints', 'WhatsApp Chatbot', 'Functional', '', 'WhatsApp number linked', B('A complaint number shall be sent back on WhatsApp'), '', '', ''],
  ['CMS/007', 'Verify if the public dashboard loads without signing in', 'Public dashboard', 'Dashboard', 'Functional', '', 'Dashboard enabled', B('KPIs shall load for an anonymous visitor'), '', '', ''],
];

const kpiRows = [
  ['New Complaints Created', 'how many complaints were filed', 'Complaints created in the selected range', 'Pass', ''],
  ['Open Complaints', 'how many complaints are open', 'Complaints not in a closing state', 'Pass', ''],
  ['Resolution Rate', 'share of complaints resolved', 'Resolved / created, as a %', 'Need more data', 'Only 3 resolved so far'],
  ['Average Resolution Time', 'time to resolve', 'Average created-to-resolved time', '', ''],
];

const SHEETS = [
  { name: 'CMS 2.20.1', rows: [MANUAL_HEADERS, ...manualRows], validations: [{ col: 8, values: STATUS }], styled: true },
  { name: 'CMS 2.20.1 Features', rows: [FEATURE_HEADERS, ...featureRows], validations: [{ col: 9, values: STATUS }], styled: true },
  { name: 'Dashboard KPI', rows: [KPI_HEADERS, ...kpiRows], validations: [{ col: 4, values: ['Fail', 'Need more data', 'Pass'] }] },
];

/** A fresh sample workbook, in memory (the unit tests' fake sheet API). */
export function buildSample(name = 'CMS Sign Off (sample)') {
  const ss = new FakeSpreadsheet(name);
  for (const t of SHEETS) {
    const n = t.rows.length - 1;
    ss.addSheet(t.name, t.rows, {
      validations: t.validations.map((v) => ({ col: v.col, fromRow: 2, toRow: n + 1, values: v.values })),
      formats: t.styled ? [{ row: 1, tag: 'header' }, ...t.rows.slice(1).map((_, i) => ({ row: i + 2, tag: 'body' }))] : [],
    });
  }
  return ss;
}

/** Cell styles standing for the fake's 'header' and 'body' format tags. */
export const HEADER_STYLE = { font: { name: 'Arial', size: 10, bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC9DAF8' } }, alignment: { vertical: 'middle', wrapText: true } };
export const BODY_STYLE = { font: { name: 'Arial', size: 10 }, alignment: { vertical: 'top', wrapText: true } };

/** The same sample as a real .xlsx (bytes), the way a downloaded Google Sheet looks. */
export async function buildSampleXlsx() {
  const wb = new ExcelJS.Workbook();
  for (const t of SHEETS) {
    const ws = wb.addWorksheet(t.name);
    t.rows.forEach((r, i) => {
      const row = ws.getRow(i + 1);
      r.forEach((v, j) => {
        const cell = row.getCell(j + 1);
        cell.value = v === '' ? null : v;
        if (t.styled) cell.style = structuredClone(i === 0 ? HEADER_STYLE : BODY_STYLE);
      });
    });
    for (const v of t.validations) {
      for (let r = 2; r <= t.rows.length; r++) {
        ws.getCell(r, v.col).dataValidation = { type: 'list', allowBlank: true, showErrorMessage: true, formulae: [`"${v.values.join(',')}"`] };
      }
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
