import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  Eye,
  EyeOff,
  FileCode2,
  KeyRound,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, formatRelative } from '../api';
import { Button, EmptyState, Modal, PageHeader, QueryErrorState, Status } from '../components/ui';
import type {
  CompilerPreviewRecord,
  PolicyRecord,
  SubscriptionFormat,
  SubscriptionRecord,
} from '../types';

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
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SubscriptionForm>(emptyForm);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [knownUrls, setKnownUrls] = useState<Record<string, string>>({});
  const [rotateTarget, setRotateTarget] = useState<SubscriptionRecord | null>(null);
  const [previewTarget, setPreviewTarget] = useState<SubscriptionRecord | null>(null);
  const [preview, setPreview] = useState<CompilerPreviewRecord | null>(null);
  const [reveal, setReveal] = useState(false);

  const subscriptions = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => api<SubscriptionRecord[]>('/subscriptions'),
  });
  const policies = useQuery({
    queryKey: ['policies'],
    queryFn: () => api<PolicyRecord[]>('/policies'),
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
        toast.success('Subscription created; save the token now');
      } else toast.success('Subscription updated');
    },
    onError: (error) => toast.error(error.message),
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/subscriptions/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: async () => {
      await invalidate();
      toast.success('Subscription status updated');
    },
    onError: (error) => toast.error(error.message),
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
      toast.success('Token rotated; the old URL is no longer valid');
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/subscriptions/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await invalidate();
      toast.success('Subscription deleted');
    },
    onError: (error) => toast.error(error.message),
  });
  const compilePreview = useMutation({
    mutationFn: (id: string) =>
      api<CompilerPreviewRecord>(`/subscriptions/${id}/preview`, { method: 'POST' }),
    onSuccess: (result) => setPreview(result),
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
    setReveal(false);
    compilePreview.mutate(item.id);
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
        title="Subscriptions"
        description="Publish compiled policies through secure, rotatable, format-bound tokens."
        actions={
          <Button onClick={openCreate}>
            <Plus size={16} /> Create subscription
          </Button>
        }
      />
      <section className="subscription-summary summary-strip">
        <div>
          <Link2 />
          <span>
            Total subscriptions<strong>{subscriptions.data?.length ?? 0}</strong>
          </span>
        </div>
        <div>
          <KeyRound />
          <span>
            Enabled<strong>{subscriptions.data?.filter((item) => item.enabled).length ?? 0}</strong>
          </span>
        </div>
        <div>
          <FileCode2 />
          <span>
            Policies
            <strong>{new Set(subscriptions.data?.map((item) => item.policyId)).size}</strong>
          </span>
        </div>
      </section>
      <div className="filter-bar">
        <Search size={17} />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search subscriptions..."
        />
        <span>{filtered.length} records</span>
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
                      {item.policy.name} · revision {item.policy.revision}
                    </p>
                  </div>
                  <Status value={expired ? 'EXPIRED' : item.enabled ? 'ENABLED' : 'DISABLED'} />
                </header>
                <dl>
                  <div>
                    <dt>Format</dt>
                    <dd>{item.format}</dd>
                  </div>
                  <div>
                    <dt>Token</dt>
                    <dd className="mono">{item.tokenPrefix}••••</dd>
                  </div>
                  <div>
                    <dt>Expiration</dt>
                    <dd>{item.expiresAt ? new Date(item.expiresAt).toLocaleString() : 'Never'}</dd>
                  </div>
                  <div>
                    <dt>Last access</dt>
                    <dd>{item.lastAccessAt ? formatRelative(item.lastAccessAt) : 'Never'}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{formatRelative(item.createdAt)}</dd>
                  </div>
                </dl>
                <div className="subscription-actions">
                  <button onClick={() => openPreview(item)}>
                    <Eye size={14} /> Preview
                  </button>
                  <button
                    disabled={!knownUrl}
                    title={knownUrl ? 'Copy subscription URL' : 'Rotate token to reveal a new URL'}
                    onClick={() => knownUrl && void copyText(knownUrl, 'Subscription URL copied')}
                  >
                    <Copy size={14} /> Copy URL
                  </button>
                  <button onClick={() => openEdit(item)}>
                    <Pencil size={14} /> Edit
                  </button>
                  <button onClick={() => toggle.mutate({ id: item.id, enabled: !item.enabled })}>
                    {item.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button onClick={() => setRotateTarget(item)}>
                    <RefreshCw size={14} /> Rotate
                  </button>
                  <button
                    className="danger"
                    aria-label={`Delete ${item.name}`}
                    onClick={() => {
                      if (window.confirm(`Delete subscription “${item.name}”?`))
                        remove.mutate(item.id);
                    }}
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
          title="No subscriptions"
          body="Create a secure subscription after defining a policy."
          action={<Button onClick={openCreate}>Create subscription</Button>}
        />
      )}

      {formOpen ? (
        <Modal
          title={editingId ? 'Edit subscription' : 'Create subscription'}
          description="The selected format is fixed for this subscription URL."
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
              <span>Name</span>
              <input
                autoFocus
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>
            <div className="form-grid">
              <label className="field">
                <span>Policy</span>
                <select
                  value={form.policyId}
                  onChange={(event) => setForm({ ...form, policyId: event.target.value })}
                >
                  <option value="">Select policy</option>
                  {policies.data?.map((policy) => (
                    <option key={policy.id} value={policy.id}>
                      {policy.name}
                      {!policy.enabled ? ' (disabled)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Format</span>
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
              <span>Expires at (optional)</span>
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
                <b>Subscription enabled</b>
                <small>Disabled tokens cannot retrieve compiled content.</small>
              </span>
            </label>
            <div className="modal-actions">
              <Button type="button" variant="secondary" onClick={() => setFormOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={save.isPending || form.name.trim().length < 2 || !form.policyId}
              >
                {editingId ? 'Save changes' : 'Create subscription'}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {issued ? (
        <Modal
          title="Token only shown once"
          description="Store this URL now. ProxyHub only keeps its cryptographic hash."
          onClose={() => setIssued(null)}
        >
          <div className="token-reveal">
            <span>Subscription URL</span>
            <code>{`${window.location.origin}${issued.path}`}</code>
            <span>Full token</span>
            <code>{issued.token}</code>
            <div className="security-callout">
              <KeyRound size={18} />
              <p>
                Anyone with this URL can fetch the subscription. It cannot be recovered after this
                dialog closes.
              </p>
            </div>
            <div className="modal-actions">
              <Button
                variant="secondary"
                onClick={() => void copyText(issued.token, 'Token copied')}
              >
                Copy token
              </Button>
              <Button
                onClick={() =>
                  void copyText(
                    `${window.location.origin}${issued.path}`,
                    'Subscription URL copied',
                  )
                }
              >
                <Copy size={15} /> Copy URL
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {rotateTarget ? (
        <Modal
          title="Rotate subscription token?"
          description="The old subscription URL will stop working immediately."
          onClose={() => setRotateTarget(null)}
        >
          <div className="confirm-dialog">
            <p>
              Rotate the token for <b>{rotateTarget.name}</b>? Connected clients must be updated
              with the new URL.
            </p>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setRotateTarget(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => rotate.mutate(rotateTarget.id)}
                disabled={rotate.isPending}
              >
                <RefreshCw size={15} /> Rotate token
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {previewTarget ? (
        <Modal
          title={`${previewTarget.name} preview`}
          description={`Compiled from ${previewTarget.policy.name} through the ${previewTarget.format} adapter.`}
          onClose={() => setPreviewTarget(null)}
        >
          <div className="subscription-preview">
            <div className="compile-summary">
              <Status
                value={
                  preview?.success ? 'SUCCESS' : compilePreview.isPending ? 'PENDING' : 'FAILURE'
                }
              />
              <button onClick={() => setReveal((value) => !value)}>
                {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
                {reveal ? 'Mask credentials' : 'Show full output'}
              </button>
              {preview ? (
                <button
                  onClick={() =>
                    void copyText(reveal ? preview.output : preview.maskedOutput, 'Preview copied')
                  }
                >
                  <Copy size={14} /> Copy
                </button>
              ) : null}
            </div>
            {preview?.errors.length || preview?.warnings.length ? (
              <div className="compiler-diagnostics">
                {[...(preview?.errors ?? []), ...(preview?.warnings ?? [])].map((item, index) => (
                  <div
                    key={`${item.code}-${index}`}
                    className={preview?.errors.includes(item) ? 'error' : 'warning'}
                  >
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
                  ? 'Compiling current policy…'
                  : preview
                    ? reveal
                      ? preview.output
                      : preview.maskedOutput
                    : 'Compile failed.'}
              </code>
            </pre>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
