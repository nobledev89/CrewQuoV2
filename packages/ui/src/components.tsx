import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

/**
 * Neutral UI primitives (packages/ui). Thin wrappers over the `styles.css`
 * class system so screens never hand-write class strings. Rebranding is a
 * tokens-only change (see styles.css).
 */

function cx(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'danger';

export function Button({
  variant = 'primary',
  size,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm';
}) {
  return (
    <button
      className={cx(
        'cq-btn',
        variant === 'secondary' && 'cq-btn--secondary',
        variant === 'danger' && 'cq-btn--danger',
        size === 'sm' && 'cq-btn--sm',
        className
      )}
      {...rest}
    />
  );
}

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('cq-card', className)} {...rest} />;
}

export function Stack({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('cq-stack', className)} {...rest} />;
}

export function Row({
  between,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { between?: boolean }) {
  return <div className={cx('cq-row', between && 'cq-row--between', className)} {...rest} />;
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="cq-field">
      <span className="cq-label">{label}</span>
      {children}
    </label>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx('cq-input', className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx('cq-select', className)} {...rest} />;
}

export function Badge({
  accent,
  children,
}: {
  accent?: boolean;
  children: ReactNode;
}) {
  return <span className={cx('cq-badge', accent && 'cq-badge--accent')}>{children}</span>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? <p className="cq-error">{children}</p> : null;
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="cq-notice">{children}</div>;
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="cq-table-wrap">
      <table className="cq-table">{children}</table>
    </div>
  );
}
