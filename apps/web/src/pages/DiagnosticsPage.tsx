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
import { Link } from 'react-router-dom';
import type {
  DiagnosticCategory,
  DiagnosticItem,
  DiagnosticStatus,
  DiagnosticsReport,
} from '@proxyhub/diagnostics-core';
import { api, formatRelative } from '../api';
import { Button, PageHeader, QueryErrorState } from '../components/ui';

const tabs: Array<{ label: string; categories: DiagnosticCategory[] }> = [
  { label: 'Overview', categories: [] },
  { label: 'Runtime', categories: ['RUNTIME', 'SYSTEM'] },
  { label: 'Database', categories: ['DATABASE'] },
  { label: 'Storage', categories: ['STORAGE'] },
  { label: 'Network', categories: ['NETWORK'] },
  { label: 'Operations', categories: ['OPERATIONS', 'RELEASE', 'BACKUP'] },
  { label: 'Rule Sets', categories: ['RULE_SET'] },
  { label: 'Subscriptions', categories: ['SUBSCRIPTION'] },
  { label: 'Security', categories: ['SECURITY', 'REALITY'] },
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
  const meta = statusMeta[status];
  const Icon = meta.icon;
  return (
    <span className={`diagnostic-status diagnostic-${meta.className}`}>
      <Icon size={14} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function DiagnosticCard({ item }: { item: DiagnosticItem }) {
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
          <dt>Observed</dt>
          <dd title={item.observedAt}>{formatRelative(item.observedAt)}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{item.source}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{item.scope}</dd>
        </div>
        <div>
          <dt>Freshness</dt>
          <dd>{item.freshness}</dd>
        </div>
      </dl>
      {item.freshness !== 'FRESH' ? (
        <div className="diagnostic-explanation">
          Data may be stale or unavailable in the current deployment mode.
        </div>
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
        <summary>Safe details</summary>
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
  return (
    <div
      className="diagnostics-grid diagnostics-loading"
      aria-live="polite"
      aria-label="Loading diagnostics"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}

export default function DiagnosticsPage() {
  const [activeTab, setActiveTab] = useState('Overview');
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
  const selected = tabs.find((tab) => tab.label === activeTab) ?? tabs[0]!;
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
        title="Diagnostics"
        description="Read-only runtime, data, resource, and operations visibility."
        actions={
          <>
            <label className="diagnostics-auto-refresh">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(event) => setAutoRefresh(event.target.checked)}
              />
              Auto refresh
            </label>
            <Button
              variant="secondary"
              onClick={() => void overview.refetch()}
              disabled={overview.isFetching}
            >
              <RefreshCw size={15} className={overview.isFetching ? 'spin' : ''} />
              Refresh
            </Button>
            <Button
              variant="secondary"
              onClick={() => void deep.mutate()}
              disabled={deep.isPending}
            >
              <ScanSearch size={15} />
              {deep.isPending ? 'Scanning…' : 'Run deep diagnostics'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => exportBundle.mutate()}
              disabled={exportBundle.isPending}
            >
              <Download size={15} /> {exportBundle.isPending ? 'Exporting…' : 'Export'}
            </Button>
          </>
        }
      />

      {report ? (
        <section className="diagnostics-summary" aria-live="polite">
          <div>
            <DiagnosticStatusBadge status={report.status} />
            <strong>Overall status</strong>
            <span>
              {report.kind === 'deep' ? 'Manual deep diagnostics' : 'Cached lightweight overview'}
            </span>
          </div>
          <div>
            <strong>{report.items.length}</strong>
            <span>bounded checks</span>
          </div>
          <div>
            <strong>{report.durationMs} ms</strong>
            <span>{report.cached ? 'cache hit' : 'collection time'}</span>
          </div>
          <div>
            <strong>{formatRelative(report.generatedAt)}</strong>
            <span>last updated</span>
          </div>
        </section>
      ) : null}

      <nav className="diagnostics-tabs" aria-label="Diagnostics sections">
        {tabs.map((tab) => (
          <button
            key={tab.label}
            className={activeTab === tab.label ? 'active' : ''}
            aria-current={activeTab === tab.label ? 'page' : undefined}
            onClick={() => setActiveTab(tab.label)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {deep.isError ? (
        <div className="diagnostic-inline-error" role="alert">
          <AlertCircle size={18} />
          <div>
            <b>Deep diagnostics did not complete</b>
            <span>{deep.error.message}</span>
          </div>
          <Button variant="secondary" onClick={() => deep.reset()}>
            Dismiss
          </Button>
        </div>
      ) : null}
      {exportBundle.isError ? (
        <div className="diagnostic-inline-error" role="alert">
          <AlertCircle size={18} />
          <div>
            <b>Diagnostics export did not complete</b>
            <span>{exportBundle.error.message}</span>
          </div>
          <Button variant="secondary" onClick={() => exportBundle.reset()}>
            Dismiss
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
            <div className="diagnostics-empty">No checks are available for this section.</div>
          ) : null}
        </section>
      )}

      <section className="diagnostics-links">
        <span>Dedicated tools</span>
        <Link to="/servers">
          Reality Compatibility <ExternalLink size={13} />
        </Link>
        <Link to="/rule-sets">
          Rule Sets <ExternalLink size={13} />
        </Link>
        <Link to="/subscriptions">
          Subscriptions <ExternalLink size={13} />
        </Link>
      </section>
      <p className="diagnostics-boundary">
        Diagnostics are read-only. They never restart services, apply configuration, deploy, roll
        back, restore backups, fetch remote rule sets, or run Reality compatibility tests.
      </p>
    </div>
  );
}
