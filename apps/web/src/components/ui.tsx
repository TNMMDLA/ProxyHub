import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  PropsWithChildren,
  ReactNode,
} from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api';

export function Button({
  className = '',
  variant = 'primary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  return <button className={`button button-${variant} ${className}`} {...props} />;
}

export function Input({
  label,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...props} />
      {error ? <small>{error}</small> : null}
    </label>
  );
}

export function Status({ value }: { value: string }) {
  const { t } = useTranslation('common');
  return (
    <span className={`status status-${value.toLowerCase()}`}>
      <i />
      {t(`statusLabels.${value}`, {
        defaultValue: value.charAt(0) + value.slice(1).toLowerCase(),
      })}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function Modal({
  title,
  description,
  onClose,
  children,
  className = '',
}: PropsWithChildren<{
  title: string;
  description?: string;
  onClose: () => void;
  className?: string;
}>) {
  const { t } = useTranslation('common');
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header>
          <div>
            <h2 id="modal-title">{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button className="icon-button" onClick={onClose} aria-label={t('close')}>
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function QueryErrorState({
  error,
  onRetry,
  fullPage = false,
}: {
  error: unknown;
  onRetry: () => void;
  fullPage?: boolean;
}) {
  const { t } = useTranslation(['errors', 'common']);
  const message =
    error instanceof ApiError
      ? t(`errors:${error.code}`, { defaultValue: error.message })
      : error instanceof Error
        ? error.message
        : t('errors:unexpected');
  return (
    <section className={fullPage ? 'query-error full-page-error' : 'query-error'}>
      <div className="empty-icon">
        <X size={25} />
      </div>
      <h2>{t('errors:viewTitle')}</h2>
      <p>{message}</p>
      <div className="query-error-actions">
        <Button onClick={onRetry}>{t('common:retry')}</Button>
        <Button variant="secondary" onClick={() => window.location.assign('/dashboard')}>
          {t('common:returnDashboard')}
        </Button>
      </div>
    </section>
  );
}
