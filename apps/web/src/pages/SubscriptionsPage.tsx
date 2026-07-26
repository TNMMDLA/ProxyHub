import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  Eye,
  FileCode2,
  KeyRound,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  ShieldCheck,
  TestTube2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';
import { Button, EmptyState, Modal, PageHeader, QueryErrorState, Status } from '../components/ui';
import type {
  PolicyRecord,
  SubscriptionCapabilityRecord,
  SubscriptionFormat,
  SubscriptionPreviewRecord,
  SubscriptionRecord,
  SubscriptionResponseTestRecord,
} from '../types';
import type { SubscriptionReadinessResult } from '@proxyhub/shared';
import { useTranslation } from 'react-i18next';
import {
  formatDateTime,
  formatDuration,
  formatFileSize,
  formatRelativeTime,
} from '../i18n/formatters';
import type { SupportedLocale } from '../i18n';
import { confirmDeleteWithImpact } from '../delete-impact';

interface SubscriptionForm {
  name: string;
  policyId: string;
  format: SubscriptionFormat;
  enabled: boolean;
  expiresAt: string;
}

interface IssuedToken {
  subscription: SubscriptionRecord;
  token: string;
  path: string;
}

const emptyForm: SubscriptionForm = {
  name: '',
  policyId: '',
  format: 'mihomo',
  enabled: true,
  expiresAt: '',
};

function expirationPayload(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

export default function SubscriptionsPage() {
  const { t, i18n } = useTranslation(['subscriptions', 'common', 'errors']);
  const locale: SupportedLocale = i18n.resolvedLanguage === 'zh-CN' ? 'zh-CN' : 'en';
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SubscriptionForm>(emptyForm);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [knownUrls, setKnownUrls] = useState<Record<string, string>>({});
  const [rotateTarget, setRotateTarget] = useState<SubscriptionRecord | null>(null);
  const [previewTarget, setPreviewTarget] = useState<SubscriptionRecord | null>(null);
  const [preview, setPreview] = useState<SubscriptionPreviewRecord | null>(null);
  const [readinessTarget, setReadinessTarget] = useState<SubscriptionRecord | null>(null);
  const [readiness, setReadiness] = useState<SubscriptionReadinessResult | null>(null);
  const [responseTarget, setResponseTarget] = useState<SubscriptionRecord | null>(null);
  const [responseTest, setResponseTest] = useState<SubscriptionResponseTestRecord | null>(null);
  const previewController = useRef<AbortController | null>(null);

  const subscriptions = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => api<SubscriptionRecord[]>('/subscriptions'),
  });
  const policies = useQuery({
    queryKey: ['policies'],
    queryFn: () => api<PolicyRecord[]>('/policies'),
  });
  const capabilities = useQuery({
    queryKey: ['subscription-capabilities'],
    queryFn: () => api<SubscriptionCapabilityRecord[]>('/subscriptions/capabilities'),
    staleTime: 60_000,
  });
  const invalidate = () => client.invalidateQueries({ queryKey: ['subscriptions'] });

  const save = useMutation<SubscriptionRecord | IssuedToken, Error, SubscriptionForm>({
    mutationFn: (input: SubscriptionForm) =>
      editingId
        ? api<SubscriptionRecord>(`/subscriptions/${editingId}`, {
            method: 'PATCH',
            body: JSON.stringify({ ...input, expiresAt: expirationPayload(input.expiresAt) }),
          })
        : api<IssuedToken>('/subscriptions', {
            method: 'POST',
            body: JSON.stringify({ ...input, expiresAt: expirationPayload(input.expiresAt) }),
          }),
    onSuccess: async (result) => {
      setFormOpen(false);
      setForm(emptyForm);
      setEditingId(null);
      await invalidate();
      if ('token' in result) {
        const url = `${window.location.origin}${result.path}`;
        setIssued(result);
        setKnownUrls((current) => ({ ...current, [result.subscription.id]: url }));
        toast.success(t('subscriptions:created'));
      } else toast.success(t('subscriptions:updated'));
    },
    onError: (error) =>
      toast.error(
        'code' in error
          ? t(`errors:${String(error.code)}`, { defaultValue: error.message })
          : error.message,
      ),
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/subscriptions/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('subscriptions:statusUpdated'));
    },
    onError: (error) => {
      if (error.name !== 'AbortError') toast.error(error.message);
    },
  });
  const rotate = useMutation({
    mutationFn: (id: string) =>
      api<IssuedToken>(`/subscriptions/${id}/rotate-token`, { method: 'POST' }),
    onSuccess: async (result) => {
      setRotateTarget(null);
      await invalidate();
      const url = `${window.location.origin}${result.path}`;
      setIssued(result);
      setKnownUrls((current) => ({ ...current, [result.subscription.id]: url }));
      toast.success(t('subscriptions:tokenRotated'));
    },
    onError: (error) => {
      if (error.name !== 'AbortError') toast.error(error.message);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/subscriptions/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('subscriptions:deleted'));
    },
    onError: (error) => toast.error(error.message),
  });
  const compilePreview = useMutation({
    mutationFn: ({ id, signal }: { id: string; signal: AbortSignal }) =>
      api<SubscriptionPreviewRecord>(`/subscriptions/${id}/preview`, {
        method: 'POST',
        body: JSON.stringify({}),
        signal,
      }),
    onSuccess: (result) => setPreview(result),
    onError: (error) => {
      if (error.name !== 'AbortError') toast.error(error.message);
    },
  });
  const checkReadiness = useMutation({
    mutationFn: (id: string) =>
      api<SubscriptionReadinessResult>(`/subscriptions/${id}/readiness`, { method: 'POST' }),
    onSuccess: (result) => setReadiness(result),
    onError: (error) => toast.error(error.message),
  });
  const runResponseTest = useMutation({
    mutationFn: (id: string) =>
      api<SubscriptionResponseTestRecord>(`/subscriptions/${id}/test-response`, {
        method: 'POST',
      }),
    onSuccess: (result) => setResponseTest(result),
    onError: (error) => toast.error(error.message),
  });

  const filtered = useMemo(() => {
    const needle = search.toLowerCase();
    return (subscriptions.data ?? []).filter((item) =>
      `${item.name} ${item.policy.name} ${item.format}`.toLowerCase().includes(needle),
    );
  }, [search, subscriptions.data]);

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...emptyForm, policyId: policies.data?.find((item) => item.enabled)?.id ?? '' });
    setFormOpen(true);
  };
  const openEdit = (item: SubscriptionRecord) => {
    setEditingId(item.id);
    setForm({
      name: item.name,
      policyId: item.policyId,
      format: item.format,
      enabled: item.enabled,
      expiresAt: item.expiresAt ? new Date(item.expiresAt).toISOString().slice(0, 16) : '',
    });
    setFormOpen(true);
  };
  const openPreview = (item: SubscriptionRecord) => {
    setPreviewTarget(item);
    setPreview(null);
    previewController.current?.abort();
    previewController.current = new AbortController();
    compilePreview.mutate({ id: item.id, signal: previewController.current.signal });
  };
  const copyText = async (value: string, message: string) => {
    await navigator.clipboard.writeText(value);
    toast.success(message);
  };

  if (subscriptions.isError || policies.isError) {
    const failed = subscriptions.isError ? subscriptions : policies;
    return <QueryErrorState error={failed.error} onRetry={() => void failed.refetch()} />;
  }

  return (
    <>
      <PageHeader
        title={t('subscriptions:title')}
        description={t('subscriptions:description')}
        actions={
          <Button onClick={openCreate}>
            <Plus size={16} /> {t('subscriptions:create')}
          </Button>
        }
      />
      <section className="subscription-summary summary-strip">
        <div>
          <Link2 />
          <span>
            {t('subscriptions:total')}
            <strong>{subscriptions.data?.length ?? 0}</strong>
          </span>
        </div>
        <div>
          <KeyRound />
          <span>
            {t('subscriptions:enabled')}
            <strong>{subscriptions.data?.filter((item) => item.enabled).length ?? 0}</strong>
          </span>
        </div>
        <div>
          <FileCode2 />
          <span>
            {t('subscriptions:policies')}
            <strong>{new Set(subscriptions.data?.map((item) => item.policyId)).size}</strong>
          </span>
        </div>
      </section>
      <div className="filter-bar">
        <Search size={17} />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('subscriptions:search')}
        />
        <span>{t('subscriptions:records', { count: filtered.length })}</span>
      </div>
      {filtered.length ? (
        <section className="subscription-grid">
          {filtered.map((item) => {
            const expired = Boolean(item.expiresAt && new Date(item.expiresAt) <= new Date());
            const knownUrl = knownUrls[item.id];
            return (
              <article key={item.id}>
                <header>
                  <span className="subscription-icon">
                    <Link2 size={19} />
                  </span>
                  <div>
                    <h3>{item.name}</h3>
                    <p>
                      {item.policy.name} ·{' '}
                      {t('subscriptions:revision', { value: item.policy.revision })}
                    </p>
                  </div>
                  <Status value={expired ? 'EXPIRED' : item.enabled ? 'ENABLED' : 'DISABLED'} />
                </header>
                <dl>
                  <div>
                    <dt>{t('subscriptions:format')}</dt>
                    <dd>{item.format}</dd>
                  </div>
                  <div>
                    <dt>{t('subscriptions:token')}</dt>
                    <dd className="mono">{item.tokenPrefix}••••</dd>
                  </div>
                  <div>
                    <dt>{t('subscriptions:expiration')}</dt>
                    <dd>
                      {item.expiresAt ? formatDateTime(item.expiresAt, locale) : t('common:never')}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('subscriptions:lastAccess')}</dt>
                    <dd>
                      {item.lastAccessAt
                        ? formatRelativeTime(item.lastAccessAt, locale)
                        : t('common:never')}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('subscriptions:createdAt')}</dt>
                    <dd>{formatRelativeTime(item.createdAt, locale)}</dd>
                  </div>
                </dl>
                <div className="subscription-actions">
                  <button onClick={() => openPreview(item)}>
                    <Eye size={14} /> {t('subscriptions:preview')}
                  </button>
                  <button
                    onClick={() => {
                      setReadinessTarget(item);
                      setReadiness(null);
                      checkReadiness.mutate(item.id);
                    }}
                  >
                    <ShieldCheck size={14} /> {t('subscriptions:runReadiness')}
                  </button>
                  <button
                    onClick={() => {
                      setResponseTarget(item);
                      setResponseTest(null);
                      runResponseTest.mutate(item.id);
                    }}
                  >
                    <TestTube2 size={14} /> {t('subscriptions:testResponse')}
                  </button>
                  <button
                    disabled={!knownUrl}
                    title={
                      knownUrl ? t('subscriptions:copyUrlTitle') : t('subscriptions:rotateToReveal')
                    }
                    onClick={() => knownUrl && void copyText(knownUrl, 'Subscription URL copied')}
                  >
                    <Copy size={14} /> {t('subscriptions:copyUrl')}
                  </button>
                  <button onClick={() => openEdit(item)}>
                    <Pencil size={14} /> {t('common:edit')}
                  </button>
                  <button onClick={() => toggle.mutate({ id: item.id, enabled: !item.enabled })}>
                    {item.enabled ? t('subscriptions:disable') : t('subscriptions:enable')}
                  </button>
                  <button onClick={() => setRotateTarget(item)}>
                    <RefreshCw size={14} /> {t('subscriptions:rotate')}
                  </button>
                  <button
                    className="danger"
                    aria-label={t('subscriptions:deleteTitle')}
                    onClick={() =>
                      void confirmDeleteWithImpact('SUBSCRIPTION', item.id, item.name)
                        .then((confirmed) => {
                          if (confirmed) remove.mutate(item.id);
                        })
                        .catch((error: Error) => toast.error(error.message))
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      ) : (
        <EmptyState
          icon={<Link2 />}
          title={t('subscriptions:noSubscriptions')}
          body={t('subscriptions:emptyDescription')}
          action={<Button onClick={openCreate}>{t('subscriptions:create')}</Button>}
        />
      )}
      <section className="panel subscription-capabilities">
        <div className="panel-title">
          <div>
            <h3>{t('subscriptions:capabilities')}</h3>
            <p>{t('subscriptions:capabilityDescription')}</p>
          </div>
        </div>
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th>{t('subscriptions:format')}</th>
                {[
                  'nodes',
                  'reality',
                  'visionFlow',
                  'proxyGroups',
                  'nodePoolMapping',
                  'routingRules',
                  'ruleSets',
                  'dns',
                  'finalRule',
                  'subscriptionToken',
                  'etag',
                  'configPreview',
                ].map((feature) => (
                  <th key={feature}>{feature}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(capabilities.data ?? []).map((capability) => (
                <tr key={capability.format}>
                  <td>
                    <b>{capability.format}</b>
                  </td>
                  {Object.values(capability.features).map((state, index) => (
                    <td key={`${capability.format}-${String(index)}`}>
                      <Status value={state} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel client-guides">
        <div className="panel-title">
          <div>
            <h3>{t('subscriptions:clientGuide')}</h3>
            <p>{t('subscriptions:capabilityDescription')}</p>
          </div>
        </div>
        <div className="client-guide-grid">
          {(['clash', 'mihomo', 'singbox', 'v2rayn', 'v2rayng'] as const).map((client) => (
            <article key={client}>
              <h4>{t(`subscriptions:guides.${client}.name`)}</h4>
              <Status
                value={
                  client === 'singbox'
                    ? 'PARTIAL'
                    : client === 'v2rayn' || client === 'v2rayng'
                      ? 'PARTIAL'
                      : 'SUPPORTED'
                }
              />
              <b>{t(`subscriptions:guides.${client}.format`)}</b>
              <p>{t(`subscriptions:guides.${client}.steps`)}</p>
              <small>{t(`subscriptions:guides.${client}.limits`)}</small>
              <a href="/diagnostics?tab=subscriptions">{t('common:openDiagnostics')}</a>
            </article>
          ))}
        </div>
      </section>

      {formOpen ? (
        <Modal
          title={editingId ? t('subscriptions:edit') : t('subscriptions:create')}
          description={t('subscriptions:formDescription')}
          onClose={() => setFormOpen(false)}
        >
          <form
            className="modal-form"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate(form);
            }}
          >
            <label className="field">
              <span>{t('common:name')}</span>
              <input
                autoFocus
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>
            <div className="form-grid">
              <label className="field">
                <span>{t('subscriptions:policy')}</span>
                <select
                  value={form.policyId}
                  onChange={(event) => setForm({ ...form, policyId: event.target.value })}
                >
                  <option value="">{t('subscriptions:selectPolicy')}</option>
                  {policies.data?.map((policy) => (
                    <option key={policy.id} value={policy.id}>
                      {policy.name}
                      {!policy.enabled ? t('subscriptions:disabledSuffix') : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('subscriptions:format')}</span>
                <select
                  value={form.format}
                  onChange={(event) =>
                    setForm({ ...form, format: event.target.value as SubscriptionFormat })
                  }
                >
                  <option value="mihomo">Mihomo / Clash</option>
                  <option value="sing-box">sing-box</option>
                  <option value="raw">Raw VLESS URIs</option>
                </select>
              </label>
            </div>
            <label className="field">
              <span>{t('subscriptions:expiresOptional')}</span>
              <input
                type="datetime-local"
                value={form.expiresAt}
                onChange={(event) => setForm({ ...form, expiresAt: event.target.value })}
              />
            </label>
            <label className="enabled-toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              />
              <span>
                <b>{t('subscriptions:subscriptionEnabled')}</b>
                <small>{t('subscriptions:disabledHelp')}</small>
              </span>
            </label>
            <div className="modal-actions">
              <Button type="button" variant="secondary" onClick={() => setFormOpen(false)}>
                {t('common:cancel')}
              </Button>
              <Button
                type="submit"
                disabled={save.isPending || form.name.trim().length < 2 || !form.policyId}
              >
                {editingId ? t('subscriptions:saveChanges') : t('subscriptions:create')}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {issued ? (
        <Modal
          title={t('subscriptions:tokenOnce')}
          description={t('subscriptions:tokenOnceDescription')}
          onClose={() => setIssued(null)}
        >
          <div className="token-reveal">
            <span>{t('subscriptions:subscriptionUrl')}</span>
            <code>{`${window.location.origin}${issued.path}`}</code>
            <span>{t('subscriptions:fullToken')}</span>
            <code>{issued.token}</code>
            <div className="security-callout">
              <KeyRound size={18} />
              <p>{t('subscriptions:tokenWarning')}</p>
            </div>
            <div className="modal-actions">
              <Button
                variant="secondary"
                onClick={() => void copyText(issued.token, 'Token copied')}
              >
                {t('subscriptions:copyToken')}
              </Button>
              <Button
                onClick={() =>
                  void copyText(
                    `${window.location.origin}${issued.path}`,
                    'Subscription URL copied',
                  )
                }
              >
                <Copy size={15} /> {t('subscriptions:copyUrl')}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {rotateTarget ? (
        <Modal
          title={t('subscriptions:rotateTitle')}
          description={t('subscriptions:rotateDescription')}
          onClose={() => setRotateTarget(null)}
        >
          <div className="confirm-dialog">
            <p>{t('subscriptions:rotateConfirm', { name: rotateTarget.name })}</p>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setRotateTarget(null)}>
                {t('common:cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => rotate.mutate(rotateTarget.id)}
                disabled={rotate.isPending}
              >
                <RefreshCw size={15} /> {t('subscriptions:rotateToken')}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {previewTarget ? (
        <Modal
          title={t('subscriptions:previewTitle', { name: previewTarget.name })}
          description={t('subscriptions:previewDescription', {
            policy: previewTarget.policy.name,
            format: previewTarget.format,
          })}
          onClose={() => {
            previewController.current?.abort();
            setPreviewTarget(null);
          }}
        >
          <div className="subscription-preview">
            <div className="compile-summary">
              <Status
                value={preview ? 'READY' : compilePreview.isPending ? 'IN_PROGRESS' : 'FAILED'}
              />
              {compilePreview.isPending ? (
                <button
                  onClick={() => {
                    previewController.current?.abort();
                    compilePreview.reset();
                  }}
                >
                  {t('common:cancel')}
                </button>
              ) : null}
              <span>
                <ShieldCheck size={14} /> {t('subscriptions:sanitizedPreview')}
              </span>
              {preview ? (
                <button
                  onClick={() => void copyText(preview.output, t('subscriptions:previewCopied'))}
                >
                  <Copy size={14} /> {t('common:copy')}
                </button>
              ) : null}
            </div>
            {preview?.truncated ? (
              <p className="preview-warning">{t('subscriptions:truncated')}</p>
            ) : null}
            {preview?.warnings.length ? (
              <div className="compiler-diagnostics">
                {preview.warnings.map((item, index) => (
                  <div key={`${item.code}-${index}`} className="warning">
                    <b>{item.code}</b>
                    <span>
                      {item.ruleName ? `${item.ruleName}: ` : ''}
                      {item.message}
                    </span>
                    <small>{item.adapter}</small>
                  </div>
                ))}
              </div>
            ) : null}
            <pre className="config-preview">
              <code>
                {compilePreview.isPending
                  ? t('subscriptions:compiling')
                  : preview
                    ? preview.output
                    : t('subscriptions:compileFailed')}
              </code>
            </pre>
          </div>
        </Modal>
      ) : null}
      {readinessTarget ? (
        <Modal
          title={`${readinessTarget.name} · ${t('subscriptions:readinessTitle')}`}
          onClose={() => setReadinessTarget(null)}
        >
          <div className="readiness-panel">
            {checkReadiness.isPending ? (
              <p>{t('subscriptions:compiling')}</p>
            ) : readiness ? (
              <>
                <header>
                  <Status value={readiness.status} />
                  <span>
                    {t('subscriptions:readinessChecked', {
                      time: formatDateTime(readiness.checkedAt, locale),
                      duration: formatDuration(readiness.durationMs, locale),
                    })}
                  </span>
                  <b>{t('subscriptions:blockingIssues', { count: readiness.blockingCount })}</b>
                  <b>{t('subscriptions:warnings', { count: readiness.warningCount })}</b>
                </header>
                <div className="readiness-checks">
                  {readiness.checks.map((item) => (
                    <article key={item.id}>
                      <Status value={item.status} />
                      <div>
                        <b>
                          {t(`subscriptions:${item.titleCode}`, {
                            defaultValue: item.titleCode,
                          })}
                        </b>
                        <p>
                          {t(`subscriptions:${item.summaryCode}`, {
                            defaultValue: item.summaryCode,
                          })}
                        </p>
                        {item.errorCode ? <code>{item.errorCode}</code> : null}
                        {item.resourceType ? (
                          <small>
                            {item.resourceType}
                            {item.resourceName ? ` · ${item.resourceName}` : ''}
                          </small>
                        ) : null}
                        <small>
                          {t(`subscriptions:readiness.stages.${item.stage}`, {
                            defaultValue: item.stage,
                          })}
                          {item.field ? ` · ${item.field}` : ''}
                        </small>
                        {item.recommendations.length ? (
                          <ul>
                            {item.recommendations.map((recommendation) => (
                              <li key={recommendation}>
                                {t(`subscriptions:readiness.recommendations.${recommendation}`, {
                                  defaultValue: recommendation,
                                })}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
                <a className="button button-secondary" href="/diagnostics?tab=subscriptions">
                  {t('common:openDiagnostics')}
                </a>
              </>
            ) : null}
          </div>
        </Modal>
      ) : null}
      {responseTarget ? (
        <Modal
          title={`${responseTarget.name} · ${t('subscriptions:responseTitle')}`}
          onClose={() => setResponseTarget(null)}
        >
          <div className="response-test-panel">
            {runResponseTest.isPending ? (
              <p>{t('subscriptions:compiling')}</p>
            ) : responseTest ? (
              <>
                <Status value={responseTest.accessible ? 'READY' : 'BLOCKED'} />
                <dl>
                  <div>
                    <dt>{t('subscriptions:httpStatus')}</dt>
                    <dd>{responseTest.statusCode}</dd>
                  </div>
                  <div>
                    <dt>{t('subscriptions:contentType')}</dt>
                    <dd>{responseTest.contentType ?? responseTest.errorCode}</dd>
                  </div>
                  <div>
                    <dt>{t('subscriptions:cacheControl')}</dt>
                    <dd>{responseTest.cacheControl ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>ETag</dt>
                    <dd className="mono">{responseTest.etag ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>{t('subscriptions:responseSize')}</dt>
                    <dd>{formatFileSize(responseTest.responseBytes ?? 0, locale)}</dd>
                  </div>
                </dl>
              </>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}
