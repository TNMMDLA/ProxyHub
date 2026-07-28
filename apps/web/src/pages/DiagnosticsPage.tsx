import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Download,
  ExternalLink,
  RefreshCw,
  ScanSearch,
  ShieldQuestion,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import type {
  DiagnosticCategory,
  DiagnosticItem,
  DiagnosticStatus,
  DiagnosticsReport,
} from '@proxyhub/diagnostics-core';
import { api, formatRelative } from '../api';
import { Button, PageHeader, QueryErrorState } from '../components/ui';
import { useTranslation } from 'react-i18next';

const tabs: Array<{ id: string; categories: DiagnosticCategory[] }> = [
  { id: 'overview', categories: [] },
  { id: 'runtime', categories: ['RUNTIME', 'SYSTEM'] },
  { id: 'database', categories: ['DATABASE'] },
  { id: 'storage', categories: ['STORAGE'] },
  { id: 'network', categories: ['NETWORK'] },
  { id: 'operations', categories: ['OPERATIONS', 'RELEASE', 'BACKUP'] },
  { id: 'rule-sets', categories: ['RULE_SET'] },
  { id: 'subscriptions', categories: ['SUBSCRIPTION'] },
  { id: 'security', categories: ['SECURITY', 'REALITY'] },
];

const statusMeta: Record<
  DiagnosticStatus,
  { label: string; icon: typeof CheckCircle2; className: string }
> = {
  HEALTHY: { label: 'Healthy', icon: CheckCircle2, className: 'healthy' },
  WARNING: { label: 'Warning', icon: AlertTriangle, className: 'warning' },
  CRITICAL: { label: 'Critical', icon: AlertCircle, className: 'critical' },
  UNKNOWN: { label: 'Unknown', icon: CircleHelp, className: 'unknown' },
  NOT_AVAILABLE: { label: 'Unavailable', icon: ShieldQuestion, className: 'unavailable' },
  NOT_APPLICABLE: { label: 'Not applicable', icon: CircleHelp, className: 'unavailable' },
};

function DiagnosticStatusBadge({ status }: { status: DiagnosticStatus }) {
  const { t } = useTranslation('common');
  const meta = statusMeta[status];
  const Icon = meta.icon;
  return (
    <span className={`diagnostic-status diagnostic-${meta.className}`}>
      <Icon size={14} aria-hidden="true" />
      {t(`statusLabels.${status}`, { defaultValue: meta.label })}
    </span>
  );
}

function DiagnosticCard({ item }: { item: DiagnosticItem }) {
  const { t } = useTranslation(['diagnostics', 'common']);
  return (
    <article className="diagnostic-card">
      <header>
        <div>
          <span className="diagnostic-category">{item.category.replace('_', ' ')}</span>
          <h3>{item.title}</h3>
        </div>
        <DiagnosticStatusBadge status={item.status} />
      </header>
      <p>{item.summary}</p>
      <dl>
        <div>
          <dt>{t('diagnostics:observed')}</dt>
          <dd title={item.observedAt}>{formatRelative(item.observedAt)}</dd>
        </div>
        <div>
          <dt>{t('diagnostics:source')}</dt>
          <dd>{item.source}</dd>
        </div>
        <div>
          <dt>{t('diagnostics:scope')}</dt>
          <dd>{item.scope}</dd>
        </div>
        <div>
          <dt>{t('diagnostics:freshness')}</dt>
          <dd>{item.freshness}</dd>
        </div>
      </dl>
      {item.freshness !== 'FRESH' ? (
        <div className="diagnostic-explanation">{t('diagnostics:staleExplanation')}</div>
      ) : null}
      {item.errorCode ? <code className="diagnostic-code">{item.errorCode}</code> : null}
      {item.recommendations.length ? (
        <ul>
          {item.recommendations.map((recommendation) => (
            <li key={recommendation}>{recommendation}</li>
          ))}
        </ul>
      ) : null}
      <details>
        <summary>{t('diagnostics:safeDetails')}</summary>
        <div className="diagnostic-details">
          {Object.entries(item.details).map(([key, value]) => (
            <div key={key}>
              <span>{key.replace(/([A-Z])/g, ' $1')}</span>
              <b>{Array.isArray(value) ? value.join(', ') : String(value ?? 'Unavailable')}</b>
            </div>
          ))}
        </div>
      </details>
    </article>
  );
}

function DiagnosticsSkeleton() {
  const { t } = useTranslation('diagnostics');
  return (
    <div
      className="diagnostics-grid diagnostics-loading"
      aria-live="polite"
      aria-label={t('diagnostics:loadingAria')}
    >
      {Array.from({ length: 6 }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}

export default function DiagnosticsPage() {
  const { t } = useTranslation(['diagnostics', 'common', 'navigation']);
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get('tab');
  const [activeTab, setActiveTab] = useState(
    tabs.some((tab) => tab.id === requestedTab) ? requestedTab! : 'overview',
  );
  const [autoRefresh, setAutoRefresh] = useState(true);
  const overview = useQuery({
    queryKey: ['diagnostics', 'overview'],
    queryFn: () => api<DiagnosticsReport>('/diagnostics/overview'),
    refetchInterval: () => (autoRefresh && document.visibilityState === 'visible' ? 30_000 : false),
    staleTime: 10_000,
    retry: 1,
  });
  const deep = useMutation({
    mutationFn: () => api<DiagnosticsReport>('/diagnostics/run', { method: 'POST' }),
  });
  const exportBundle = useMutation({
    mutationFn: () => api<DiagnosticsReport>('/diagnostics/export'),
    onSuccess: (bundle) => {
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `proxyhub-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    },
  });
  const report = deep.data ?? overview.data;
  const selected = tabs.find((tab) => tab.id === activeTab) ?? tabs[0]!;
  const items = useMemo(
    () =>
      report?.items.filter(
        (item) => selected.categories.length === 0 || selected.categories.includes(item.category),
      ) ?? [],
    [report, selected],
  );

  if (overview.isError && !overview.data)
    return <QueryErrorState error={overview.error} onRetry={() => void overview.refetch()} />;

  return (
    <div className="diagnostics-page">
      <PageHeader
        title={t('diagnostics:title')}
        description={t('diagnostics:description')}
        actions={
          <>
            <label className="diagnostics-auto-refresh">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(event) => setAutoRefresh(event.target.checked)}
              />
              {t('diagnostics:autoRefresh')}
            </label>
            <Button
              variant="secondary"
              onClick={() => void overview.refetch()}
              disabled={overview.isFetching}
            >
              <RefreshCw size={15} className={overview.isFetching ? 'spin' : ''} />
              {t('common:refresh')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void deep.mutate()}
              disabled={deep.isPending}
            >
              <ScanSearch size={15} />
              {deep.isPending ? t('diagnostics:scanning') : t('diagnostics:runDeep')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => exportBundle.mutate()}
              disabled={exportBundle.isPending}
            >
              <Download size={15} />{' '}
              {exportBundle.isPending ? t('diagnostics:exporting') : t('diagnostics:export')}
            </Button>
          </>
        }
      />

      {report ? (
        <section className="diagnostics-summary" aria-live="polite">
          <div>
            <DiagnosticStatusBadge status={report.status} />
            <strong>{t('diagnostics:overall')}</strong>
            <span>
              {report.kind === 'deep'
                ? t('diagnostics:manualDeep')
                : t('diagnostics:cachedOverview')}
            </span>
          </div>
          <div>
            <strong>{report.items.length}</strong>
            <span>{t('diagnostics:boundedChecks')}</span>
          </div>
          <div>
            <strong>{report.durationMs} ms</strong>
            <span>
              {report.cached ? t('diagnostics:cacheHit') : t('diagnostics:collectionTime')}
            </span>
          </div>
          <div>
            <strong>{formatRelative(report.generatedAt)}</strong>
            <span>{t('diagnostics:lastUpdated')}</span>
          </div>
        </section>
      ) : null}

      <nav className="diagnostics-tabs" aria-label={t('diagnostics:sectionsAria')}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={activeTab === tab.id ? 'active' : ''}
            aria-current={activeTab === tab.id ? 'page' : undefined}
            onClick={() => {
              setActiveTab(tab.id);
              setParams(tab.id === 'overview' ? {} : { tab: tab.id }, { replace: true });
            }}
          >
            {t(`diagnostics:tabs.${tab.id}`)}
          </button>
        ))}
      </nav>

      {deep.isError ? (
        <div className="diagnostic-inline-error" role="alert">
          <AlertCircle size={18} />
          <div>
            <b>{t('diagnostics:deepFailed')}</b>
            <span>{deep.error.message}</span>
          </div>
          <Button variant="secondary" onClick={() => deep.reset()}>
            {t('diagnostics:dismiss')}
          </Button>
        </div>
      ) : null}
      {exportBundle.isError ? (
        <div className="diagnostic-inline-error" role="alert">
          <AlertCircle size={18} />
          <div>
            <b>{t('diagnostics:exportFailed')}</b>
            <span>{exportBundle.error.message}</span>
          </div>
          <Button variant="secondary" onClick={() => exportBundle.reset()}>
            {t('diagnostics:dismiss')}
          </Button>
        </div>
      ) : null}

      {overview.isLoading ? (
        <DiagnosticsSkeleton />
      ) : (
        <section className="diagnostics-grid" aria-live="polite">
          {items.map((item) => (
            <DiagnosticCard key={item.id} item={item} />
          ))}
          {items.length === 0 ? (
            <div className="diagnostics-empty">{t('diagnostics:empty')}</div>
          ) : null}
        </section>
      )}

      <section className="diagnostics-links">
        <span>{t('diagnostics:dedicatedTools')}</span>
        <Link to="/servers">
          {t('diagnostics:realityCompatibility')} <ExternalLink size={13} />
        </Link>
        <Link to="/rule-sets">
          {t('navigation:ruleSets')} <ExternalLink size={13} />
        </Link>
        <Link to="/subscriptions">
          {t('navigation:subscriptions')} <ExternalLink size={13} />
        </Link>
        <Link to="/nodes?performance=1">
          {t('diagnostics:networkPerformance')} <ExternalLink size={13} />
        </Link>
      </section>
      <p className="diagnostics-boundary">{t('diagnostics:boundary')}</p>
    </div>
  );
}
