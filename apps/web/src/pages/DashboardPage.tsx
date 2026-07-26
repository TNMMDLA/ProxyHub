import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Boxes,
  CircleAlert,
  CircleCheck,
  Cpu,
  Plus,
  Server,
  ShieldCheck,
  Waypoints,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Button, QueryErrorState, Status } from '../components/ui';
import type { AuditRecord, ServerRecord } from '../types';
import type { SetupProgressResult } from '@proxyhub/shared';
import { useTranslation } from 'react-i18next';
import { formatRelativeTime } from '../i18n/formatters';
import type { SupportedLocale } from '../i18n';

interface DashboardData {
  metrics: {
    serversOnline: number;
    serversTotal: number;
    healthyNodes: number;
    nodesTotal: number;
    activePools: number;
    poolsTotal: number;
    securityScore: number;
    unreadNotifications: number;
  };
  system: {
    hostname: string;
    uptime: number;
    memoryUsage: number;
    load: number;
    version: string;
    xrayStatus: string;
  };
  servers: ServerRecord[];
  activity: AuditRecord[];
  traffic: Array<{ time: string; inbound: number; outbound: number }>;
  trafficMode: 'DEMO';
}

export default function DashboardPage() {
  const { t, i18n } = useTranslation(['dashboard', 'common']);
  const locale: SupportedLocale = i18n.resolvedLanguage === 'zh-CN' ? 'zh-CN' : 'en';
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<DashboardData>('/dashboard'),
    refetchInterval: 30_000,
  });
  const setup = useQuery({
    queryKey: ['setup-progress'],
    queryFn: () => api<SetupProgressResult>('/setup/progress'),
    staleTime: 5_000,
    refetchInterval: 30_000,
  });
  if (query.isError) {
    return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (!query.data)
    return (
      <div className="page-skeleton">
        <span />
        <span />
        <span />
      </div>
    );
  const { metrics, system, servers, activity, traffic } = query.data;
  const metricItems = [
    {
      label: t('dashboard:serversOnline'),
      value: `${metrics.serversOnline} / ${metrics.serversTotal}`,
      note: t('dashboard:ofServers', {
        value: metrics.serversTotal
          ? Math.round((metrics.serversOnline / metrics.serversTotal) * 100)
          : 0,
      }),
      icon: Server,
      tone: 'blue',
    },
    {
      label: t('dashboard:healthyNodes'),
      value: `${metrics.healthyNodes} / ${metrics.nodesTotal}`,
      note: t('dashboard:ofNodes', {
        value: metrics.nodesTotal
          ? Math.round((metrics.healthyNodes / metrics.nodesTotal) * 100)
          : 0,
      }),
      icon: Waypoints,
      tone: 'green',
    },
    {
      label: t('dashboard:activePools'),
      value: `${metrics.activePools} / ${metrics.poolsTotal}`,
      note: t('dashboard:dynamicGroups'),
      icon: Boxes,
      tone: 'violet',
    },
    {
      label: t('dashboard:securityScore'),
      value: `${metrics.securityScore} / 100`,
      note:
        metrics.securityScore >= 80
          ? t('dashboard:strongProtection')
          : t('dashboard:reviewRecommendations'),
      icon: ShieldCheck,
      tone: 'amber',
    },
  ];
  return (
    <div className="dashboard-page">
      <div className="dashboard-actions">
        <Button variant="secondary" onClick={() => navigate('/servers')}>
          {t('dashboard:addServer')} <Plus size={16} />
        </Button>
        <Button onClick={() => navigate('/nodes?create=1')}>
          {t('dashboard:createNode')} <Plus size={16} />
        </Button>
      </div>
      <section className="metric-rail">
        {metricItems.map((item) => (
          <article key={item.label}>
            <div className={`metric-icon ${item.tone}`}>
              <item.icon size={24} />
            </div>
            <div>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.note}</small>
            </div>
          </article>
        ))}
      </section>
      {setup.data ? (
        <section className="panel quick-start-panel">
          <div className="panel-title">
            <div>
              <h3>{t('dashboard:quickStart')}</h3>
              <p>{t('dashboard:quickStartDescription')}</p>
            </div>
            <Status value={setup.data.overallStatus} />
          </div>
          <div className="setup-progress" aria-label={t('dashboard:quickStart')}>
            <span>
              {t('dashboard:setupProgress', {
                completed: setup.data.completedSteps,
                total: setup.data.totalSteps,
              })}
            </span>
            <progress value={setup.data.completedSteps} max={setup.data.totalSteps} />
          </div>
          <div className="quick-start-steps">
            {setup.data.steps.map((step) => (
              <article key={step.id}>
                <Status value={step.status} />
                <div>
                  <b>{t(`dashboard:steps.${step.id}.title`)}</b>
                  <p>{t(`dashboard:steps.${step.id}.description`)}</p>
                </div>
                {step.status !== 'COMPLETED' ? (
                  <Button variant="secondary" onClick={() => navigate(step.targetRoute)}>
                    {t('dashboard:continueStep')} <ArrowRight size={14} />
                  </Button>
                ) : (
                  <CircleCheck size={18} className="success-icon" />
                )}
              </article>
            ))}
          </div>
        </section>
      ) : setup.isError ? (
        <section className="panel compact-error">
          <QueryErrorState error={setup.error} onRetry={() => void setup.refetch()} />
        </section>
      ) : null}
      <div className="dashboard-grid">
        <section className="panel traffic-panel">
          <div className="panel-title">
            <div>
              <h3>{t('dashboard:networkTraffic')}</h3>
              <p>
                <i className="blue-dot" />
                {t('dashboard:demoData')}
                <i className="green-dot" />
                <b>{t('dashboard:trafficNotConfigured')}</b>
              </p>
            </div>
            <div className="range-tabs">
              <button className="active">24H</button>
              <button>7D</button>
              <button>30D</button>
            </div>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={traffic} margin={{ top: 12, right: 10, left: -22, bottom: 0 }}>
                <defs>
                  <linearGradient id="blueArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#1768e8" stopOpacity={0.16} />
                    <stop offset="95%" stopColor="#1768e8" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="greenArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#16a060" stopOpacity={0.12} />
                    <stop offset="95%" stopColor="#16a060" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="#e8edf5" strokeDasharray="3 3" />
                <XAxis
                  dataKey="time"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: '#73809a', fontSize: 11 }}
                />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: '#73809a', fontSize: 11 }} />
                <Tooltip
                  contentStyle={{
                    border: '1px solid #dae2ef',
                    borderRadius: 10,
                    boxShadow: '0 12px 28px rgba(19,42,76,.12)',
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="inbound"
                  stroke="#1768e8"
                  strokeWidth={2}
                  fill="url(#blueArea)"
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="outbound"
                  stroke="#16a060"
                  strokeWidth={2}
                  fill="url(#greenArea)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="panel security-panel">
          <h3>{t('dashboard:securityScore')}</h3>
          <div className="score-content">
            <div
              className="score-ring"
              style={{ '--score': `${metrics.securityScore * 3.6}deg` } as React.CSSProperties}
            >
              <div>
                <strong>{metrics.securityScore}</strong>
                <span>/100</span>
              </div>
            </div>
            <ul>
              <li>
                <i className="green-dot" />
                {t('dashboard:secure')} <b>7</b>
              </li>
              <li>
                <i className="amber-dot" />
                {t('common:warning')} <b>{metrics.securityScore < 90 ? 2 : 0}</b>
              </li>
              <li>
                <i className="red-dot" />
                {t('common:critical')} <b>0</b>
              </li>
              <li>
                <i className="blue-dot" />
                {t('dashboard:info')} <b>{metrics.unreadNotifications}</b>
              </li>
            </ul>
          </div>
          <button className="text-link" onClick={() => navigate('/security')}>
            {t('dashboard:viewSecurity')} <ArrowRight size={15} />
          </button>
        </section>
        <section className="panel infra-panel">
          <div className="panel-title">
            <div>
              <h3>{t('dashboard:infrastructureHealth')}</h3>
              <p>
                {t('dashboard:systemSummary', {
                  hostname: system.hostname,
                  memory: `${system.memoryUsage}%`,
                  load: system.load.toFixed(2),
                  xray: t(`common:statusLabels.${system.xrayStatus}`),
                })}
              </p>
            </div>
          </div>
          {servers.length ? (
            <div className="data-table">
              <div className="table-head">
                <span>{t('dashboard:server')}</span>
                <span>{t('dashboard:region')}</span>
                <span>{t('common:status')}</span>
                <span>{t('dashboard:cpu')}</span>
                <span>{t('dashboard:memory')}</span>
                <span>Xray</span>
              </div>
              {servers.slice(0, 5).map((server) => (
                <div className="table-row" key={server.id}>
                  <span className="server-name">
                    <i className={server.status === 'ONLINE' ? 'online' : 'offline'} />
                    <b>{server.name}</b>
                    <small>{server.hostname}</small>
                  </span>
                  <span>{server.region}</span>
                  <span>
                    <Status value={server.status} />
                  </span>
                  <span>{server.cpuUsage.toFixed(0)}%</span>
                  <span>{server.memoryUsage.toFixed(0)}%</span>
                  <span>
                    <Status value={system.xrayStatus} />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="panel-empty">{t('dashboard:noServers')}</p>
          )}
          <button className="text-link" onClick={() => navigate('/servers')}>
            {t('dashboard:viewServers')} <ArrowRight size={15} />
          </button>
        </section>
        <section className="panel activity-panel">
          <h3>{t('dashboard:recentActivity')}</h3>
          <div className="timeline">
            {activity.length ? (
              activity.map((item) => (
                <div key={item.id}>
                  <span
                    className={
                      item.result === 'SUCCESS' ? 'timeline-icon success' : 'timeline-icon warning'
                    }
                  >
                    {item.result === 'SUCCESS' ? (
                      <CircleCheck size={16} />
                    ) : (
                      <CircleAlert size={16} />
                    )}
                  </span>
                  <p>
                    <b>{item.action.replaceAll('_', ' ').toLowerCase()}</b>
                    <small>
                      {item.resource}
                      {item.resourceId ? ` · ${item.resourceId.slice(-6)}` : ''}
                    </small>
                  </p>
                  <time>
                    {formatRelativeTime(item.createdAt, locale)}
                    <small>{item.actorName}</small>
                  </time>
                </div>
              ))
            ) : (
              <div>
                <span className="timeline-icon info">
                  <Cpu size={16} />
                </span>
                <p>
                  <b>{t('dashboard:systemInitialized')}</b>
                  <small>{t('dashboard:waitingActivity')}</small>
                </p>
                <time>
                  {t('dashboard:now')}
                  <small>{t('dashboard:systemActor')}</small>
                </time>
              </div>
            )}
          </div>
          <button className="text-link" onClick={() => navigate('/audit-logs')}>
            {t('dashboard:viewActivity')} <ArrowRight size={15} />
          </button>
        </section>
      </div>
    </div>
  );
}
