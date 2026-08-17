import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

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
export function Table({ children, label }: { children: ReactNode; label?: string }) { return <div className="cq-table-wrap"><table className="cq-table" aria-label={label}>{children}</table></div>; }
