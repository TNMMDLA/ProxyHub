import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Gauge, Play, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type {
  NetworkPerformanceProgress,
  NetworkPerformanceRating,
} from '@proxyhub/network-performance-core';
import { api, ApiError } from '../api';
import { Button, EmptyState, Modal, QueryErrorState } from '../components/ui';
import { formatDateTime, formatDuration, formatNumber } from '../i18n/formatters';
import { normalizeLocale } from '../i18n';
import type { NodeRecord } from '../types';

interface PerformanceCapability {
  available: boolean;
  targetCount: number;
  busy: boolean;
  maxConcurrentRuns: 1;
}

interface PerformanceSummary {
  score?: {
    overall: number | null;
    throughput: number | null;
    successRate: number;
    stability: number | null;
    connectionRating: NetworkPerformanceRating;
    throughputRating: NetworkPerformanceRating;
    stabilityRating: NetworkPerformanceRating;
    overallRating: NetworkPerformanceRating;
  };
  tunnelEstablishmentMs?: number | null;
  medianDirectMbps?: number | null;
  medianTunnelMbps?: number | null;
  successRatePercent?: number;
  analysisCodes?: string[];
  errorCode?: string;
}

interface PerformanceEnvironment {
  source?: string;
  serverName?: string;
  serverRegion?: string;
  nodeName?: string;
  nodePort?: number;
  protocol?: string;
  transport?: string;
  security?: string;
  flow?: string;
  realityTarget?: string;
  sni?: string;
  xrayVersion?: string;
  proxyhubVersion?: string;
  gitSha?: string;
  deployMode?: string;
  testedAt?: string;
}

interface PerformanceTargetRecord {
  id: string;
  targetId: string;
  targetLabel: string;
  success: boolean;
  errorCode: string | null;
  directMbps: number | null;
  tunnelMbps: number | null;
  efficiencyPercent: number | null;
  latencyMedianMs: number | null;
  latencyP95Ms: number | null;
  jitterMs: number | null;
  successfulRequests: number;
  failedRequests: number;
  uploadStatus: 'NOT_AVAILABLE';
  analysisCodes: string[];
}

interface PerformanceRunRecord {
  id: string;
  nodeId: string;
  status: string;
  score: number | null;
  summary: PerformanceSummary;
  environment: PerformanceEnvironment;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  targetResults: PerformanceTargetRecord[];
  progress: NetworkPerformanceProgress | null;
}

interface PerformanceHistoryRecord {
  id: string;
  status: string;
  score: number | null;
  summary: PerformanceSummary;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

const terminalStatuses = new Set(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'INTERRUPTED']);

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="performance-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function NetworkPerformancePanel({
  node,
  onClose,
}: {
  node: NodeRecord;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation(['networkPerformance', 'common', 'errors']);
  const locale = normalizeLocale(i18n.resolvedLanguage) ?? 'en';
  const client = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const notifiedRun = useRef<string | null>(null);
  const capability = useQuery({
    queryKey: ['network-performance-capability'],
    queryFn: () => api<PerformanceCapability>('/nodes/performance-tests/capability'),
    staleTime: 10_000,
  });
  const history = useQuery({
    queryKey: ['network-performance-history', node.id],
    queryFn: () => api<PerformanceHistoryRecord[]>(`/nodes/${node.id}/performance-tests`),
  });
  const selected = useQuery({
    queryKey: ['network-performance-run', node.id, selectedRunId],
    queryFn: () =>
      api<PerformanceRunRecord>(`/nodes/${node.id}/performance-tests/${selectedRunId!}`),
    enabled: selectedRunId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && !terminalStatuses.has(status) ? 500 : false;
    },
  });
  const start = useMutation({
    mutationFn: () =>
      api<PerformanceRunRecord>(`/nodes/${node.id}/performance-tests`, {
        method: 'POST',
      }),
    onSuccess: (run) => {
      notifiedRun.current = null;
      setSelectedRunId(run.id);
      void client.invalidateQueries({ queryKey: ['network-performance-capability'] });
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : 'NETWORK_PERFORMANCE_INTERNAL_ERROR';
      toast.error(t(`networkPerformance:error.${code}`, { defaultValue: error.message }));
    },
  });
  const cancel = useMutation({
    mutationFn: (runId: string) =>
      api(`/nodes/${node.id}/performance-tests/${runId}/cancel`, { method: 'POST' }),
    onSuccess: () => toast.success(t('networkPerformance:cancelRequested')),
    onError: (error) => toast.error(error.message),
  });

  const run = selected.data;
  useEffect(() => {
    if (!run || !terminalStatuses.has(run.status) || notifiedRun.current === run.id) return;
    notifiedRun.current = run.id;
    if (run.status === 'COMPLETED' || run.status === 'PARTIAL') {
      toast.success(t('networkPerformance:completedToast'));
    }
    void client.invalidateQueries({ queryKey: ['network-performance-history', node.id] });
    void client.invalidateQueries({ queryKey: ['network-performance-capability'] });
  }, [client, node.id, run, t]);

  const formatMetric = (value: number | null | undefined, suffix: string) =>
    value === null || value === undefined
      ? t('networkPerformance:notAvailable')
      : `${formatNumber(Math.round(value * 10) / 10, locale)} ${suffix}`;
  const rating = (value: NetworkPerformanceRating | undefined) =>
    t(`networkPerformance:rating.${value ?? 'UNKNOWN'}`);

  return (
    <Modal
      title={t('networkPerformance:title', { name: node.name })}
      description={t('networkPerformance:scope')}
      onClose={onClose}
      className="network-performance-modal"
    >
      <div className="network-performance-panel">
        {capability.isError || history.isError ? (
          <QueryErrorState
            error={capability.error ?? history.error}
            onRetry={() => {
              void capability.refetch();
              void history.refetch();
            }}
          />
        ) : (
          <>
            <section className="performance-toolbar">
              <div>
                <b>
                  {capability.data?.available
                    ? t('networkPerformance:targetCount', {
                        count: capability.data.targetCount,
                      })
                    : t('networkPerformance:capabilityUnavailable')}
                </b>
              </div>
              <Button
                disabled={
                  start.isPending ||
                  !node.enabled ||
                  !capability.data?.available ||
                  Boolean(run && !terminalStatuses.has(run.status))
                }
                onClick={() => start.mutate()}
              >
                <Play size={15} />
                {t('networkPerformance:start')}
              </Button>
            </section>

            {selected.isError ? (
              <QueryErrorState error={selected.error} onRetry={() => void selected.refetch()} />
            ) : run && !terminalStatuses.has(run.status) ? (
              <section className="performance-running">
                <div className="performance-running-icon">
                  <Activity size={24} />
                </div>
                <div>
                  <h3>{t('networkPerformance:runningTitle')}</h3>
                  <p>
                    {t(`networkPerformance:stage.${run.progress?.stage ?? 'PREPARING'}`, {
                      current: run.progress?.currentTarget ?? 0,
                      total: run.progress?.totalTargets ?? capability.data?.targetCount ?? 0,
                    })}
                  </p>
                  <small>
                    {t('networkPerformance:remainingSteps', {
                      count: run.progress?.remainingSteps ?? 0,
                    })}
                  </small>
                </div>
                <Button
                  variant="secondary"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate(run.id)}
                >
                  <Square size={14} />
                  {t('networkPerformance:cancel')}
                </Button>
              </section>
            ) : run ? (
              <div className="performance-result">
                <section className="performance-score-card">
                  <div>
                    <span>{t('networkPerformance:score')}</span>
                    <strong>
                      {run.score === null ? '—' : `${formatNumber(run.score, locale)} / 100`}
                    </strong>
                    <b>{rating(run.summary.score?.overallRating)}</b>
                  </div>
                  <div className="performance-ratings">
                    <Metric
                      label={t('networkPerformance:connection')}
                      value={rating(run.summary.score?.connectionRating)}
                    />
                    <Metric
                      label={t('networkPerformance:throughput')}
                      value={rating(run.summary.score?.throughputRating)}
                    />
                    <Metric
                      label={t('networkPerformance:stability')}
                      value={rating(run.summary.score?.stabilityRating)}
                    />
                  </div>
                </section>

                {run.status === 'PARTIAL' ? (
                  <p className="performance-notice">{t('networkPerformance:partialNote')}</p>
                ) : null}
                {['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(run.status) ? (
                  <p className="performance-notice error">
                    {run.summary.errorCode
                      ? t(`networkPerformance:error.${run.summary.errorCode}`)
                      : t('networkPerformance:failedNote')}
                  </p>
                ) : null}

                <section className="performance-section">
                  <h3>{t('networkPerformance:connectionPerformance')}</h3>
                  <div className="performance-metric-grid">
                    <Metric
                      label={t('networkPerformance:tunnelEstablishment')}
                      value={
                        run.summary.tunnelEstablishmentMs === null ||
                        run.summary.tunnelEstablishmentMs === undefined
                          ? t('networkPerformance:notAvailable')
                          : formatDuration(run.summary.tunnelEstablishmentMs, locale)
                      }
                    />
                    <Metric
                      label={t('networkPerformance:medianDownload')}
                      value={formatMetric(run.summary.medianTunnelMbps, 'Mbps')}
                    />
                    <Metric
                      label={t('networkPerformance:successRate')}
                      value={formatMetric(run.summary.successRatePercent, '%')}
                    />
                    <Metric
                      label={t('networkPerformance:upload')}
                      value={t('networkPerformance:notAvailable')}
                    />
                  </div>
                </section>

                {run.targetResults.length > 0 ? (
                  <section className="performance-section">
                    <h3>{t('networkPerformance:multiTarget')}</h3>
                    <div className="performance-target-grid">
                      {run.targetResults.map((target) => (
                        <article className="performance-target-card" key={target.id}>
                          <header>
                            <b>{target.targetLabel}</b>
                            <span
                              className={`status status-${target.success ? 'healthy' : 'failed'}`}
                            >
                              {t(
                                `networkPerformance:status.${target.success ? 'COMPLETED' : 'FAILED'}`,
                              )}
                            </span>
                          </header>
                          <div className="performance-target-metrics">
                            <Metric
                              label={t('networkPerformance:direct')}
                              value={formatMetric(target.directMbps, 'Mbps')}
                            />
                            <Metric
                              label={t('networkPerformance:tunnel')}
                              value={formatMetric(target.tunnelMbps, 'Mbps')}
                            />
                            <Metric
                              label={t('networkPerformance:efficiency')}
                              value={formatMetric(target.efficiencyPercent, '%')}
                            />
                            <Metric
                              label={t('networkPerformance:medianLatency')}
                              value={formatMetric(target.latencyMedianMs, 'ms')}
                            />
                            <Metric
                              label={t('networkPerformance:p95Latency')}
                              value={formatMetric(target.latencyP95Ms, 'ms')}
                            />
                            <Metric
                              label={t('networkPerformance:jitter')}
                              value={formatMetric(target.jitterMs, 'ms')}
                            />
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                ) : null}

                {run.summary.analysisCodes?.length ? (
                  <section className="performance-section">
                    <h3>{t('networkPerformance:analysis')}</h3>
                    <ul className="performance-analysis">
                      {run.summary.analysisCodes.map((code) => (
                        <li key={code}>
                          {t(`networkPerformance:analysisCode.${code}`, { defaultValue: code })}
                        </li>
                      ))}
                      <li>{t('networkPerformance:clientReminder')}</li>
                    </ul>
                  </section>
                ) : null}

                {run.environment.testedAt ? (
                  <section className="performance-section performance-environment">
                    <h3>{t('networkPerformance:environment')}</h3>
                    <dl>
                      {[
                        ['source', t('networkPerformance:proxyhubServer')],
                        ['server', run.environment.serverName],
                        ['region', run.environment.serverRegion],
                        ['node', run.environment.nodeName],
                        ['port', run.environment.nodePort],
                        ['protocol', run.environment.protocol],
                        ['transport', run.environment.transport],
                        ['security', run.environment.security],
                        ['flow', run.environment.flow],
                        ['realityTarget', run.environment.realityTarget],
                        ['sni', run.environment.sni],
                        ['xrayVersion', run.environment.xrayVersion],
                        ['proxyhubVersion', run.environment.proxyhubVersion],
                        ['build', run.environment.gitSha],
                        ['deployMode', run.environment.deployMode],
                        ['testedAt', formatDateTime(run.environment.testedAt, locale)],
                      ].map(([key, value]) => (
                        <div key={String(key)}>
                          <dt>{t(`networkPerformance:${String(key)}`)}</dt>
                          <dd>{String(value ?? '—')}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                ) : null}
              </div>
            ) : null}

            <section className="performance-section performance-history">
              <h3>{t('networkPerformance:history')}</h3>
              {history.data?.length ? (
                <div className="performance-history-list">
                  {history.data.map((item) => (
                    <button
                      className={selectedRunId === item.id ? 'selected' : ''}
                      key={item.id}
                      onClick={() => setSelectedRunId(item.id)}
                    >
                      <span>{formatDateTime(item.startedAt, locale)}</span>
                      <b>
                        {item.score === null
                          ? t(`networkPerformance:status.${item.status}`)
                          : `${formatNumber(item.score, locale)} / 100`}
                      </b>
                      <small>
                        {formatMetric(item.summary.medianTunnelMbps, 'Mbps')} ·{' '}
                        {formatMetric(item.summary.successRatePercent, '%')}
                      </small>
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={<Gauge />}
                  title={t('networkPerformance:emptyTitle')}
                  body={t('networkPerformance:emptyBody')}
                />
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
