import { useEffect, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

function cx(...parts: (string | false | undefined)[]): string { return parts.filter(Boolean).join(' '); }
type ButtonVariant = 'primary' | 'secondary' | 'danger';

export function Button({ variant = 'primary', size, className, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' }) {
  return <button type={type} className={cx('cq-btn', variant === 'secondary' && 'cq-btn--secondary', variant === 'danger' && 'cq-btn--danger', size === 'sm' && 'cq-btn--sm', className)} {...rest} />;
}
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) { return <div className={cx('cq-card', className)} {...rest} />; }
export function Stack({ className, ...rest }: HTMLAttributes<HTMLDivElement>) { return <div className={cx('cq-stack', className)} {...rest} />; }
export function Row({ between, className, ...rest }: HTMLAttributes<HTMLDivElement> & { between?: boolean }) { return <div className={cx('cq-row', between && 'cq-row--between', className)} {...rest} />; }
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <label className="cq-field"><span className="cq-label">{label}</span>{children}{hint ? <span className="cq-muted">{hint}</span> : null}</label>; }
export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) { return <input className={cx('cq-input', className)} {...rest} />; }
export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) { return <select className={cx('cq-select', className)} {...rest} />; }
export function SearchInput(props: InputHTMLAttributes<HTMLInputElement>) { return <div className="cq-search"><svg className="cq-search__icon" aria-hidden="true" viewBox="0 0 20 20" fill="none"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.7"/><path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg><Input type="search" autoComplete="off" {...props} /></div>; }
export function Badge({ accent, tone = 'neutral', children }: { accent?: boolean; tone?: 'neutral' | 'accent' | 'success' | 'warning'; children: ReactNode }) { const actualTone = accent ? 'accent' : tone; return <span className={cx('cq-badge', actualTone === 'accent' && 'cq-badge--accent', actualTone === 'success' && 'cq-badge--success', actualTone === 'warning' && 'cq-badge--warning')}>{children}</span>; }
export function ErrorText({ children }: { children: ReactNode }) { return children ? <p className="cq-error" role="alert">{children}</p> : null; }
export function Notice({ children }: { children: ReactNode }) { return <div className="cq-notice">{children}</div>; }
export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) { return <header className="cq-page-header"><div className="cq-page-header__copy">{eyebrow ? <p className="cq-page-header__eyebrow">{eyebrow}</p> : null}<h1 className="cq-h1">{title}</h1>{description ? <p className="cq-page-header__description">{description}</p> : null}</div>{actions ? <div className="cq-page-header__actions">{actions}</div> : null}</header>; }
export function Section({ title, description, actions, children, className }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string }) { return <section className={cx('cq-section', className)}>{title || actions ? <div className="cq-section__header"><div>{title ? <h2 className="cq-h2">{title}</h2> : null}{description ? <p className="cq-section__description">{description}</p> : null}</div>{actions}</div> : null}<div className="cq-section__body">{children}</div></section>; }
export function EmptyState({ title, children }: { title: string; children: ReactNode }) { return <div className="cq-empty"><p className="cq-empty__title">{title}</p><p className="cq-empty__copy">{children}</p></div>; }
export function Table({ children, label, compact }: { children: ReactNode; label?: string; compact?: boolean }) { return <div className="cq-table-wrap"><table className={cx('cq-table', compact && 'cq-table--compact')} aria-label={label}>{children}</table></div>; }

export type SortDirection = 'asc' | 'desc';
export interface SortState { key: string; direction: SortDirection }

/**
 * A sortable column header (§40 opens its density paragraph with "sortable columns").
 *
 * `aria-sort` is the accessible state *and* the styling hook, so the caret and the
 * screen-reader announcement can never disagree. Pass `numeric` for figure columns:
 * it right-aligns the header over a `cq-numeric` column.
 */
export function SortableTh({ label, sortKey, sort, onSort, numeric, width }: {
  label: string;
  sortKey: string;
  sort: SortState | null;
  onSort: (key: string) => void;
  numeric?: boolean;
  width?: string;
}) {
  const active = sort?.key === sortKey;
  return (
    <th
      scope="col"
      className={cx('cq-th--sortable', numeric && 'cq-numeric')}
      aria-sort={active ? (sort!.direction === 'asc' ? 'ascending' : 'descending') : undefined}
      style={width ? { width } : undefined}
    >
      <button type="button" className="cq-sort" onClick={() => onSort(sortKey)}>
        <span>{label}</span>
        <svg className="cq-sort__caret" viewBox="0 0 10 10" aria-hidden="true" fill="none">
          {active && sort!.direction === 'asc'
            ? <path d="M5 2.5 8 7H2z" fill="currentColor" />
            : <path d="M5 7.5 2 3h6z" fill="currentColor" />}
        </svg>
      </button>
    </th>
  );
}

/**
 * A right-hand side panel for the work that would otherwise be pinned above a table.
 *
 * Closes on Escape and on a backdrop click, because a panel that can only be dismissed
 * by finding its Cancel button is a modal wearing a drawer's clothes.
 */
export function Drawer({ open, title, description, onClose, footer, children }: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="cq-drawer-backdrop" onClick={onClose} />
      <aside className="cq-drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="cq-drawer__header">
          <div>
            <h2 className="cq-h2">{title}</h2>
            {description ? <p className="cq-drawer__description">{description}</p> : null}
          </div>
          {/* "Close panel", not "Close": a footer often carries its own dismiss button,
              and two controls sharing one accessible name inside a dialog is ambiguous
              to a screen reader exactly as it is to a test. */}
          <button type="button" className="cq-icon-button" onClick={onClose} aria-label="Close panel">
            <svg viewBox="0 0 20 20" width="15" height="15" fill="none" aria-hidden="true">
              <path d="m5.5 5.5 9 9m0-9-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="cq-drawer__body">{children}</div>
        {footer ? <div className="cq-drawer__footer">{footer}</div> : null}
      </aside>
    </>
  );
}

export interface RailSection {
  id: string;
  label: string;
  /** Rendered beside the label. `null` = this section has nothing to count. */
  count?: number | null;
  /** False when the section exists but holds nothing — shown, dimmed, still reachable. */
  populated?: boolean;
}

/**
 * The section rail for a record (§20: "a persistent left section rail… These are
 * sections of one record, not thirteen dashboards").
 *
 * The rail marks which sections have content, which is §20's progressive-disclosure
 * rule: a project with no expenses should say so in one dim line rather than shout an
 * empty panel at the same volume as a populated one.
 */
export function SectionRail({ sections, active, onSelect, groupLabel }: {
  sections: RailSection[];
  active: string;
  onSelect: (id: string) => void;
  groupLabel?: string;
}) {
  return (
    <nav className="cq-rail" aria-label={groupLabel ?? 'Record sections'}>
      {groupLabel ? <div className="cq-rail__group">{groupLabel}</div> : null}
      {sections.map((s) => (
        <button
          key={s.id}
          type="button"
          className={cx('cq-rail__link', s.populated === false && 'cq-rail__link--empty')}
          aria-current={s.id === active ? 'true' : undefined}
          onClick={() => onSelect(s.id)}
        >
          <span>{s.label}</span>
          {typeof s.count === 'number' ? <span className="cq-rail__count">{s.count}</span> : null}
        </button>
      ))}
    </nav>
  );
}

/** The dense identity + figures strip that sits above a record's sections (§20). */
export function RecordHeader({ figures }: { figures: Array<{ label: string; value: ReactNode; note?: ReactNode }> }) {
  return (
    <div className="cq-record-head">
      {figures.map((f) => (
        <div className="cq-record-head__figure" key={f.label}>
          <div className="cq-overline">{f.label}</div>
          <div className="cq-record-head__value">{f.value}</div>
          {f.note ? <div className="cq-record-head__note">{f.note}</div> : null}
        </div>
      ))}
    </div>
  );
}
