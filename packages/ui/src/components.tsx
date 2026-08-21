import { useEffect, useRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

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
// `danger` reads as *settled badly* — a rejected request, a duplicate identifier —
// where `warning` reads as *needs attention*. The tokens already existed for
// buttons and error text; the badge simply had no variant using them.
export function Badge({ accent, tone = 'neutral', children }: { accent?: boolean; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; children: ReactNode }) { const actualTone = accent ? 'accent' : tone; return <span className={cx('cq-badge', actualTone === 'accent' && 'cq-badge--accent', actualTone === 'success' && 'cq-badge--success', actualTone === 'warning' && 'cq-badge--warning', actualTone === 'danger' && 'cq-badge--danger')}>{children}</span>; }
export function ErrorText({ children }: { children: ReactNode }) { return children ? <p className="cq-error" role="alert">{children}</p> : null; }
export function Notice({ children }: { children: ReactNode }) { return <div className="cq-notice">{children}</div>; }
export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) { return <header className="cq-page-header"><div className="cq-page-header__copy">{eyebrow ? <p className="cq-page-header__eyebrow">{eyebrow}</p> : null}<h1 className="cq-h1">{title}</h1>{description ? <p className="cq-page-header__description">{description}</p> : null}</div>{actions ? <div className="cq-page-header__actions">{actions}</div> : null}</header>; }
export function Section({ title, description, actions, children, className }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string }) { return <section className={cx('cq-section', className)}>{title || actions ? <div className="cq-section__header"><div>{title ? <h2 className="cq-h2">{title}</h2> : null}{description ? <p className="cq-section__description">{description}</p> : null}</div>{actions}</div> : null}<div className="cq-section__body">{children}</div></section>; }
export function EmptyState({ title, children }: { title: string; children: ReactNode }) { return <div className="cq-empty"><p className="cq-empty__title">{title}</p><p className="cq-empty__copy">{children}</p></div>; }
/**
 * `.cq-table-wrap` scrolls horizontally, which under SC 2.1.1 makes it a control: a
 * pointer user drags it, and without `tabIndex` a keyboard user cannot reach the columns
 * that are off-screen at all. `role="region"` with the table's own label is what makes
 * the stop announce itself as something rather than as an unnamed focusable div.
 *
 * The tabbable container is unconditional even though only wide tables overflow. The
 * automated sweep flagged exactly two routes — /admin/audit and /admin/operations — and
 * that is a fact about how much data those two happen to show, not about which tables
 * have the defect. Making it conditional on overflow would mean every table is compliant
 * until a customer has enough rows, which is the worst possible time to find out.
 */
export function Table({ children, label, compact }: { children: ReactNode; label?: string; compact?: boolean }) { return <div className="cq-table-wrap" tabIndex={0} role="region" aria-label={label}><table className={cx('cq-table', compact && 'cq-table--compact')} aria-label={label}>{children}</table></div>; }

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
 * Everything inside `panel` that a Tab press can reach, in document order.
 *
 * `:not([disabled])` and the visibility check both matter: a disabled footer button is
 * the *last* element in most of these drawers, so a trap that treated it as the boundary
 * would put Shift+Tab into a dead end while the form is still incomplete — which is
 * exactly when a keyboard user is trying to get back to the field they missed.
 *
 * Visibility is `getClientRects().length`, not `offsetParent !== null`. The offsetParent
 * idiom is the more common one and it is wrong here: it returns null for anything
 * `position: fixed`, which is what this whole panel is, so a fixed child would be
 * silently dropped from its own trap. Client rects are empty for `display: none` and
 * non-empty for a fixed element that is actually on screen, which is the question being
 * asked.
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableWithin(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
}

/**
 * A right-hand side panel for the work that would otherwise be pinned above a table.
 *
 * Closes on Escape and on a backdrop click, because a panel that can only be dismissed
 * by finding its Cancel button is a modal wearing a drawer's clothes — and it holds
 * focus, which is the behaviour `aria-modal="true"` claims and did not have.
 *
 * The attribute was here before the behaviour was, and that combination is worse than
 * neither: it tells a screen reader that everything outside this panel is inert, while
 * Tab walked straight out of it into the page behind the backdrop. A promise the
 * keyboard does not keep is not a smaller version of accessible — the user is told the
 * boundary exists and then falls through it, with no visible focus ring to say so
 * because the thing they landed on is under a translucent overlay.
 *
 * Three separate defects, all of them in this one shared component and therefore in all
 * eight drawers at once. None is visible to axe, which reads a static DOM and cannot
 * press a key:
 *
 *   1. **Focus did not enter.** Three of the eight pages put `autoFocus` on their first
 *      input; the other five opened with focus still on the trigger *behind* the panel,
 *      so the first Tab went to whatever followed that trigger — a table row, the next
 *      button in the toolbar — while the panel sat open and unreached.
 *   2. **Focus was not held.** No trap, so Tab from the last control left the dialog.
 *   3. **Focus was not returned.** On close the panel unmounted with focus inside it,
 *      which drops focus to `<body>`. The next Tab starts from the top of the document,
 *      so closing a drawer sent a keyboard user back to the skip link — from row 40 of
 *      a table they had to walk to in the first place. This is the one that makes the
 *      product unusable rather than merely awkward, and the one no scanner reports.
 *
 * `autoFocus` is honoured rather than overridden: if it has already put focus inside the
 * panel by the time this effect runs, that is a deliberate choice by the page and a
 * better destination than anything generic. Only when nothing inside has focus does the
 * panel itself take it — the panel, not its close button, so the dialog's name is
 * announced and the first Tab moves forward into the content instead of starting the
 * user on "dismiss this".
 *
 * **Where the return target comes from, and why not from the obvious place.** The first
 * version of this read `document.activeElement` in the on-open effect, which is what
 * every focus-trap tutorial does and is wrong wherever a page also uses `autoFocus`:
 * React applies `autoFocus` during commit, *before* effects run, so by the time the
 * effect looked, focus was already on the panel's own first field. The drawer therefore
 * recorded a node inside itself as the place to return to, and that node is detached by
 * the time it closes — so focus fell to the document root and the fix silently did
 * nothing on exactly the three drawers whose pages had been most careful. It passed on
 * the five that autofocus nothing, which is the worst possible distribution.
 *
 * So the target is tracked by a `focusin` listener that runs *while the drawer is
 * closed* and ignores anything inside a dialog. That is immune to the ordering, because
 * the trigger's own focus happened long before this render — and it stays correct for
 * the keyboard user specifically, who by definition had focus on the trigger to press it.
 */
export function Drawer({ open, title, description, onClose, footer, children }: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const lastOutsideRef = useRef<HTMLElement | null>(null);
  const returnToRef = useRef<HTMLElement | null>(null);

  // While closed, remember where focus is, so opening has somewhere to give it back to.
  // The dialog filter is what makes this immune to `autoFocus`: that fires during commit
  // and its `focusin` arrives before this listener is torn down, so without the filter
  // the panel's own first field would overwrite the trigger as the return target.
  useEffect(() => {
    if (open) return;
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (target instanceof HTMLElement && !target.closest('[role="dialog"]')) lastOutsideRef.current = target;
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, [open]);

  // Entry and return, keyed on `open` alone: re-running this when `onClose` changed
  // identity would return focus mid-interaction, while the panel is still open.
  useEffect(() => {
    if (!open) return;
    returnToRef.current = lastOutsideRef.current;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();
    return () => {
      const returnTo = returnToRef.current;
      returnToRef.current = null;
      // `isConnected` because closing a drawer is often the same action that removes the
      // row its trigger lived in — deleting a rate card, accepting the invite that
      // rendered the button. Focusing a detached node throws focus to the document root,
      // which is the defect this exists to fix, so an unreachable target is left alone.
      if (returnTo?.isConnected) returnTo.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const stops = focusableWithin(panel);
      // A panel whose only controls are disabled still has to hold focus; the panel
      // element is the stop of last resort rather than letting Tab leave.
      if (stops.length === 0) { e.preventDefault(); panel.focus(); return; }
      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      const active = document.activeElement;
      if (!panel.contains(active)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      {/* The backdrop is deliberately a plain div: it is a pointer affordance, and the
          keyboard path out of the dialog is Escape and the close button. Making it
          focusable would add a tab stop whose accessible name could only be "" . */}
      <div className="cq-drawer-backdrop" onClick={onClose} />
      <aside ref={panelRef} tabIndex={-1} className="cq-drawer" role="dialog" aria-modal="true" aria-label={title}>
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
