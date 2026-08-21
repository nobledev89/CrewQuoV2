import { describe, expect, it } from 'vitest';
import {
  COMPANY_EXPORT,
  EXPORT_NOTES,
  NEVER_EXPORTED_PATTERNS,
  PERSONAL_EXPORT,
  exportedColumns,
  toCsv,
  type ExportTableSpec,
} from './data-export';

const SCOPES: readonly { name: string; spec: readonly ExportTableSpec[] }[] = [
  { name: 'PERSONAL_EXPORT', spec: PERSONAL_EXPORT },
  { name: 'COMPANY_EXPORT', spec: COMPANY_EXPORT },
];

describe.each(SCOPES)('$name', ({ spec }) => {
  it('names every column it exports, and exports nothing else', () => {
    for (const table of spec) {
      expect(table.columns.length, `${table.table} exports no columns`).toBeGreaterThan(0);
      // A spec whose columns repeat produces a CSV with two identical headers, which
      // silently drops one when re-imported.
      expect(new Set(table.columns).size, `${table.table} repeats a column`).toBe(table.columns.length);
    }
  });

  it('says why each table is included and how it is scoped', () => {
    for (const table of spec) {
      // The bundle is read by an auditor with no access to this repository, so a table
      // that cannot explain itself is a table they have to guess about.
      expect(table.because.length, `${table.table} has no reason`).toBeGreaterThan(20);
      expect(table.scope.length, `${table.table} has no scope`).toBeGreaterThan(15);
    }
  });

  it('lists each table once', () => {
    const names = spec.map((t) => t.table);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives a reason for every withheld column', () => {
    for (const table of spec) {
      for (const w of table.withheld ?? []) {
        // An unexplained absence reads as an oversight, and the next person removes it.
        expect(w.why.length, `${table.table}.${w.column} is withheld with no reason`).toBeGreaterThan(20);
        // A column cannot be both.
        expect(table.columns, `${table.table}.${w.column} is both exported and withheld`).not.toContain(w.column);
      }
    }
  });

  /**
   * The canary. The allowlist is the guarantee; this is what catches the plausible line
   * somebody adds to it, because `password_hash` in a list of forty column names does
   * not look wrong at a glance.
   */
  it('contains no column matching a never-exported pattern', () => {
    for (const column of exportedColumns(spec)) {
      for (const pattern of NEVER_EXPORTED_PATTERNS) {
        expect(
          column.includes(pattern),
          `"${column}" matches the never-exported pattern "${pattern}"`
        ).toBe(false);
      }
    }
  });
});

describe('the personal/company asymmetry', () => {
  /**
   * The defect this whole file exists to prevent, asserted directly.
   *
   * A personal export built from "the tables where this person appears" is the obvious
   * implementation and it hands every crew member their employer's cost base. The row is
   * genuinely theirs; the money stapled to it is not.
   */
  it('never puts the frozen PAY snapshot in a personal export', () => {
    const timeLogs = PERSONAL_EXPORT.find((t) => t.table === 'time_logs');
    expect(timeLogs).toBeDefined();
    expect(timeLogs!.columns).not.toContain('resolved_rate');
    // And the reason is on the record, so it survives the next refactor.
    expect(timeLogs!.withheld?.map((w) => w.column)).toContain('resolved_rate');
  });

  it('does put the frozen rate in a company export, because there it is the company\'s own term', () => {
    const timeLogs = COMPANY_EXPORT.find((t) => t.table === 'time_logs');
    expect(timeLogs!.columns).toContain('resolved_rate');
  });

  it('gives a person their own expense amounts, because a claim is theirs unlike a rate', () => {
    const expenses = PERSONAL_EXPORT.find((t) => t.table === 'expenses');
    expect(expenses!.columns).toContain('amount_cents');
  });

  /**
   * A personal export must not name the other people in it.
   *
   * "Your hours were approved" is the requester's fact. "Priya approved them" is a fact
   * about Priya, and a subject-access request is not a route to a colleague's activity.
   */
  it('never identifies a second person in a personal export', () => {
    const reviewerColumns = ['reviewed_by_user_id', 'resolved_by_user_id', 'revoked_by_user_id', 'actor_user_id'];
    for (const table of PERSONAL_EXPORT) {
      for (const column of table.columns) {
        expect(
          reviewerColumns.includes(column),
          `${table.table} exports ${column}, which identifies somebody other than the requester`
        ).toBe(false);
      }
    }
  });

  it('does not put another company\'s rate cards within reach of either scope', () => {
    // Structural rather than filtered: the scope prose has to say the query is keyed on
    // this company, because that is what makes a counterparty's card unreachable rather
    // than merely excluded.
    const cards = COMPANY_EXPORT.find((t) => t.table === 'rate_cards');
    expect(cards!.scope).toContain('company_id');
    expect(PERSONAL_EXPORT.map((t) => t.table)).not.toContain('rate_cards');
  });

  it('keeps credentials and platform-authorization facts out of the account table', () => {
    const account = PERSONAL_EXPORT.find((t) => t.table === 'account');
    const withheld = account!.withheld!.map((w) => w.column);
    expect(withheld).toContain('password_hash');
    expect(withheld).toContain('google_sub');
    expect(withheld).toContain('is_super_admin');
  });
});

describe('EXPORT_NOTES', () => {
  it('states the minor-unit convention, because a bare 9200 is ambiguous', () => {
    expect(EXPORT_NOTES.join(' ')).toMatch(/minor units/i);
  });

  /**
   * The sentence §13.1 committed the product to saying before the button rather than
   * after it. An export is what somebody does immediately before erasing themselves,
   * which makes the bundle the last honest moment to say what erasure does.
   */
  it('says what deletion will and will not do', () => {
    const notes = EXPORT_NOTES.join(' ');
    expect(notes).toMatch(/without your name on them/i);
  });
});

describe('toCsv', () => {
  it('emits the spec columns as the header, whatever the rows contain', () => {
    // Not the first row's keys: a null in the last column must still produce its header,
    // or two exports of the same table have different shapes and cannot be diffed.
    const csv = toCsv(['a', 'b', 'c'], [{ a: 1 }]);
    expect(csv.split('\r\n')[0]).toBe('a,b,c');
    expect(csv.split('\r\n')[1]).toBe('1,,');
  });

  it('quotes a value containing a comma, a quote or a newline', () => {
    const csv = toCsv(['name'], [
      { name: 'SUS Contracting, Ltd' },
      { name: 'He said "no"' },
      { name: 'line one\nline two' },
    ]);
    expect(csv).toContain('"SUS Contracting, Ltd"');
    expect(csv).toContain('"He said ""no"""');
    expect(csv).toContain('"line one\nline two"');
  });

  it('keeps null and the empty string distinguishable', () => {
    // The one thing CSV can express here, and it matters: "no reason was given" is a
    // different claim from "the reason was blank".
    const csv = toCsv(['reason'], [{ reason: null }, { reason: '' }]);
    const [, nullRow, emptyRow] = csv.split('\r\n');
    expect(nullRow).toBe('');
    expect(emptyRow).toBe('""');
  });

  it('serialises a jsonb column as JSON rather than as [object Object]', () => {
    const csv = toCsv(['resolved_rate'], [{ resolved_rate: { baseCents: 9200, label: 'MON_FRI_DAY' } }]);
    expect(csv).toContain('baseCents');
    expect(csv).not.toContain('[object Object]');
  });

  it('renders a Date as an ISO instant', () => {
    const csv = toCsv(['created_at'], [{ created_at: new Date('2026-08-21T06:00:00.000Z') }]);
    expect(csv).toContain('2026-08-21T06:00:00.000Z');
  });

  it('neutralises a value a spreadsheet would run as a formula', () => {
    // `=1+1` in a description column executes on open in Excel and Sheets. A leading tab
    // is text to every importer and a formula to none.
    const csv = toCsv(['description'], [{ description: '=1+1' }]);
    expect(csv).not.toMatch(/(^|,)=1\+1/m);
    expect(csv).toContain('\t=1+1');
  });

  it('ends with a newline', () => {
    expect(toCsv(['a'], [{ a: 1 }]).endsWith('\r\n')).toBe(true);
  });
});
