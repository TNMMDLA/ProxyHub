import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  Download,
  Eye,
  FileInput,
  ListFilter,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';
import { Button, EmptyState, Modal, PageHeader, QueryErrorState, Status } from '../components/ui';
import type {
  PolicyMatchType,
  RuleSetEntryRecord,
  RuleSetFormat,
  RuleSetPreviewRecord,
  RuleSetRecord,
  RuleSetSourceType,
} from '../types';

const FORMATS: RuleSetFormat[] = ['AUTO', 'PROXYHUB_NATIVE', 'PLAIN_TEXT', 'MIHOMO'];
const TYPES: PolicyMatchType[] = [
  'DOMAIN',
  'DOMAIN_SUFFIX',
  'DOMAIN_KEYWORD',
  'DOMAIN_REGEX',
  'IP_CIDR',
  'IP_CIDR6',
  'GEOIP',
  'GEOSITE',
  'DST_PORT',
  'NETWORK',
];

interface RuleSetForm {
  name: string;
  description: string;
  enabled: boolean;
  sourceType: RuleSetSourceType;
  format: RuleSetFormat;
  sourceUrl: string;
  updateIntervalMinutes: string;
}

interface ParsePreview {
  detectedFormat: RuleSetFormat;
  parsedRules: number;
  skippedRules: number;
  duplicateCount: number;
  warnings: Array<{ code: string; message: string; lineNumber?: number }>;
  errors: Array<{ code: string; message: string; lineNumber?: number }>;
  sampleRules: Array<{ type: PolicyMatchType; value: string }>;
  contentHash: string;
}

const emptyForm: RuleSetForm = {
  name: '',
  description: '',
  enabled: true,
  sourceType: 'MANUAL',
  format: 'AUTO',
  sourceUrl: '',
  updateIntervalMinutes: '',
};

export default function RuleSetsPage() {
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<RuleSetRecord | null>(null);
  const [form, setForm] = useState<RuleSetForm>(emptyForm);
  const [previewTarget, setPreviewTarget] = useState<RuleSetRecord | null>(null);
  const [entryTarget, setEntryTarget] = useState<RuleSetEntryRecord | null>(null);
  const [entryOpen, setEntryOpen] = useState(false);
  const [entryType, setEntryType] = useState<PolicyMatchType>('DOMAIN_SUFFIX');
  const [entryValue, setEntryValue] = useState('');
  const [entrySearch, setEntrySearch] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importContent, setImportContent] = useState('');
  const [importFormat, setImportFormat] = useState<RuleSetFormat>('AUTO');
  const [importPreview, setImportPreview] = useState<ParsePreview | null>(null);

  const list = useQuery({
    queryKey: ['rule-sets'],
    queryFn: () => api<RuleSetRecord[]>('/rule-sets'),
  });
  const activeId = selectedId ?? list.data?.[0]?.id ?? null;
  const detail = useQuery({
    queryKey: ['rule-set', activeId],
    queryFn: () => api<RuleSetRecord>(`/rule-sets/${activeId}`),
    enabled: Boolean(activeId),
  });
  const cachedPreview = useQuery({
    queryKey: ['rule-set-preview', previewTarget?.id],
    queryFn: () => api<RuleSetPreviewRecord>(`/rule-sets/${previewTarget?.id}/preview?limit=50`),
    enabled: Boolean(previewTarget),
  });

  const invalidate = async (id?: string) => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['rule-sets'] }),
      ...(id ? [client.invalidateQueries({ queryKey: ['rule-set', id] })] : []),
    ]);
  };

  const save = useMutation({
    mutationFn: (input: RuleSetForm) =>
      api<RuleSetRecord>(editing ? `/rule-sets/${editing.id}` : '/rule-sets', {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify({
          name: input.name,
          description: input.description,
          enabled: input.enabled,
          ...(!editing ? { sourceType: input.sourceType } : {}),
          format: input.format,
          ...(input.sourceType === 'REMOTE' &&
          (!editing || input.sourceUrl !== (editing.sourceUrl ?? ''))
            ? { sourceUrl: input.sourceUrl }
            : {}),
          updateIntervalMinutes:
            input.sourceType === 'REMOTE' && input.updateIntervalMinutes
              ? Number(input.updateIntervalMinutes)
              : null,
        }),
      }),
    onSuccess: async (saved) => {
      setFormOpen(false);
      setEditing(null);
      setForm(emptyForm);
      setSelectedId(saved.id);
      await invalidate(saved.id);
      toast.success(editing ? 'Rule set updated' : 'Rule set created');
    },
    onError: (error) => toast.error(error.message),
  });
  const action = useMutation({
    mutationFn: ({ id, path }: { id: string; path: string }) =>
      api<unknown>(`/rule-sets/${id}/${path}`, { method: 'POST' }),
    onSuccess: async (_data, variables) => {
      await invalidate(variables.id);
      toast.success('Rule set updated');
    },
    onError: async (error, variables) => {
      await invalidate(variables.id);
      toast.error(error.message);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/rule-sets/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setSelectedId(null);
      await invalidate();
      toast.success('Rule set deleted');
    },
    onError: (error) => toast.error(error.message),
  });
  const saveEntry = useMutation({
    mutationFn: () =>
      api<RuleSetEntryRecord>(
        `/rule-sets/${activeId}/entries${entryTarget ? `/${entryTarget.id}` : ''}`,
        {
          method: entryTarget ? 'PATCH' : 'POST',
          body: JSON.stringify({ type: entryType, value: entryValue, enabled: true }),
        },
      ),
    onSuccess: async () => {
      setEntryOpen(false);
      setEntryTarget(null);
      setEntryValue('');
      if (activeId) await invalidate(activeId);
      toast.success('Rule entry saved');
    },
    onError: (error) => toast.error(error.message),
  });
  const mutateEntry = useMutation({
    mutationFn: ({
      entry,
      method,
      body,
    }: {
      entry: RuleSetEntryRecord;
      method: 'PATCH' | 'DELETE';
      body?: string;
    }) => api(`/rule-sets/${activeId}/entries/${entry.id}`, { method, ...(body ? { body } : {}) }),
    onSuccess: async () => {
      if (activeId) await invalidate(activeId);
      toast.success('Rule entry updated');
    },
    onError: (error) => toast.error(error.message),
  });
  const parseImport = useMutation({
    mutationFn: () =>
      api<ParsePreview>('/rule-sets/parse-preview', {
        method: 'POST',
        body: JSON.stringify({ content: importContent, format: importFormat }),
      }),
    onSuccess: setImportPreview,
    onError: (error) => toast.error(error.message),
  });
  const confirmImport = useMutation({
    mutationFn: () =>
      api(`/rule-sets/${activeId}/import`, {
        method: 'POST',
        body: JSON.stringify({ content: importContent, format: importFormat, mode: 'REPLACE' }),
      }),
    onSuccess: async () => {
      setImportOpen(false);
      setImportContent('');
      setImportPreview(null);
      if (activeId) await invalidate(activeId);
      toast.success('Rule set imported');
    },
    onError: (error) => toast.error(error.message),
  });
  const testSource = useMutation({
    mutationFn: () =>
      api<{ ruleCount: number; status: string; warnings: unknown[] }>('/rule-sets/test-source', {
        method: 'POST',
        body: JSON.stringify({ url: form.sourceUrl, format: form.format }),
      }),
    onSuccess: (result) => toast.success(`Source accepted: ${String(result.ruleCount)} rules`),
    onError: (error) => toast.error(error.message),
  });

  const current = detail.data;
  const visibleEntries = useMemo(() => {
    const needle = entrySearch.trim().toLowerCase();
    return (current?.entries ?? []).filter(
      (entry) => !needle || `${entry.type} ${entry.value}`.toLowerCase().includes(needle),
    );
  }, [current?.entries, entrySearch]);

  const openCreate = (sourceType: RuleSetSourceType = 'MANUAL') => {
    setEditing(null);
    setForm({ ...emptyForm, sourceType });
    setFormOpen(true);
  };
  const openEdit = (ruleSet: RuleSetRecord) => {
    setEditing(ruleSet);
    setForm({
      name: ruleSet.name,
      description: ruleSet.description,
      enabled: ruleSet.enabled,
      sourceType: ruleSet.sourceType,
      format: ruleSet.format,
      sourceUrl: ruleSet.sourceUrl ?? '',
      updateIntervalMinutes: ruleSet.updateIntervalMinutes?.toString() ?? '',
    });
    setFormOpen(true);
  };
  const exportRuleSet = async (ruleSet: RuleSetRecord) => {
    const exported = await api<Record<string, unknown>>(`/rule-sets/${ruleSet.id}/export`);
    const url = URL.createObjectURL(
      new Blob([`${JSON.stringify(exported, null, 2)}\n`], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${ruleSet.name.replaceAll(/[^a-zA-Z0-9_-]+/g, '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (list.isError)
    return <QueryErrorState error={list.error} onRetry={() => void list.refetch()} />;

  return (
    <>
      <PageHeader
        title="Rule Sets"
        description="Reusable, cached match sources for deterministic client subscription policies."
        actions={
          <div className="page-actions">
            <Button variant="secondary" onClick={() => openCreate('REMOTE')}>
              <FileInput size={15} /> Add remote
            </Button>
            <Button onClick={() => openCreate('MANUAL')}>
              <Plus size={15} /> Create manual
            </Button>
          </div>
        }
      />

      <section className="rule-set-layout">
        <aside className="rule-set-list">
          <header>
            <h2>Library</h2>
            <span>{list.data?.length ?? 0}</span>
          </header>
          {list.data?.map((ruleSet) => (
            <button
              key={ruleSet.id}
              className={activeId === ruleSet.id ? 'active' : ''}
              onClick={() => setSelectedId(ruleSet.id)}
            >
              <span>
                <b>{ruleSet.name}</b>
                <small>
                  {ruleSet.sourceType} · {ruleSet.ruleCount.toLocaleString()} rules · used by{' '}
                  {ruleSet.policyRules?.length ?? ruleSet._count.policyRules}
                </small>
              </span>
              <Status value={ruleSet.status} />
            </button>
          ))}
          {!list.isLoading && !list.data?.length ? (
            <p className="panel-empty">Create the first reusable rule set.</p>
          ) : null}
        </aside>

        <div className="rule-set-detail">
          {!activeId ? (
            <EmptyState
              icon={<ListFilter />}
              title="No rule set selected"
              body="Create a manual set or connect a remote HTTPS source."
            />
          ) : detail.isError ? (
            <QueryErrorState error={detail.error} onRetry={() => void detail.refetch()} />
          ) : !current ? (
            <div className="screen-loader">
              <span />
            </div>
          ) : (
            <>
              <header className="rule-set-title">
                <div>
                  <span className="eyebrow">
                    {current.sourceType} · REVISION {current.revision}
                  </span>
                  <h2>{current.name}</h2>
                  <p>{current.description || 'No description'}</p>
                </div>
                <div className="rule-set-actions">
                  <Button variant="secondary" onClick={() => openEdit(current)}>
                    <Pencil size={14} /> Edit
                  </Button>
                  {current.sourceType === 'REMOTE' ? (
                    <Button
                      variant="secondary"
                      onClick={() => action.mutate({ id: current.id, path: 'refresh' })}
                      disabled={action.isPending}
                    >
                      <RefreshCw size={14} /> Refresh
                    </Button>
                  ) : null}
                  <Button variant="secondary" onClick={() => setPreviewTarget(current)}>
                    <Eye size={14} /> Preview
                  </Button>
                  <Button variant="secondary" onClick={() => void exportRuleSet(current)}>
                    <Download size={14} /> Export
                  </Button>
                </div>
              </header>

              <div className="rule-set-metrics">
                <article>
                  <span>Status</span>
                  <Status value={current.status} />
                </article>
                <article>
                  <span>Total rules</span>
                  <b>{current.ruleCount.toLocaleString()}</b>
                </article>
                <article>
                  <span>Used by</span>
                  <b>{current.policyRules?.length ?? 0} policies</b>
                </article>
                <article>
                  <span>Content hash</span>
                  <code>{current.contentHash?.slice(0, 12) ?? 'Not available'}</code>
                </article>
              </div>

              {current.status === 'STALE' ? (
                <div className="rule-set-notice warning">
                  <b>Using cached version</b>
                  <span>{current.lastError}</span>
                </div>
              ) : current.status === 'ERROR' ? (
                <div className="rule-set-notice error">
                  <b>No usable cache</b>
                  <span>{current.lastError}</span>
                </div>
              ) : null}

              {current.sourceType === 'REMOTE' ? (
                <dl className="rule-set-remote">
                  <div>
                    <dt>Source URL</dt>
                    <dd>{current.sourceUrl}</dd>
                  </div>
                  <div>
                    <dt>Format</dt>
                    <dd>{current.format}</dd>
                  </div>
                  <div>
                    <dt>Last fetch</dt>
                    <dd>
                      {current.lastFetchAt
                        ? new Date(current.lastFetchAt).toLocaleString()
                        : 'Never'}
                    </dd>
                  </div>
                  <div>
                    <dt>Last success</dt>
                    <dd>
                      {current.lastSuccessAt
                        ? new Date(current.lastSuccessAt).toLocaleString()
                        : 'Never'}
                    </dd>
                  </div>
                  <div>
                    <dt>Next update</dt>
                    <dd>
                      {current.nextUpdateAt
                        ? new Date(current.nextUpdateAt).toLocaleString()
                        : 'Manual only'}
                    </dd>
                  </div>
                </dl>
              ) : (
                <section className="rule-entry-section">
                  <div className="section-heading">
                    <div>
                      <h2>Manual rules</h2>
                      <p>Stored order is preserved when the policy expands this set.</p>
                    </div>
                    <div className="rule-set-actions">
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setImportOpen(true);
                          setImportPreview(null);
                        }}
                      >
                        <Upload size={14} /> Bulk import
                      </Button>
                      <Button
                        onClick={() => {
                          setEntryTarget(null);
                          setEntryType('DOMAIN_SUFFIX');
                          setEntryValue('');
                          setEntryOpen(true);
                        }}
                      >
                        <Plus size={14} /> Add rule
                      </Button>
                    </div>
                  </div>
                  <label className="rule-entry-search">
                    <Search size={15} />
                    <input
                      value={entrySearch}
                      onChange={(event) => setEntrySearch(event.target.value)}
                      placeholder="Search cached rules..."
                    />
                  </label>
                  <div className="rule-entry-table">
                    {visibleEntries.slice(0, 200).map((entry) => (
                      <div key={entry.id} className={!entry.enabled ? 'disabled' : ''}>
                        <code>{entry.type}</code>
                        <span>{entry.value}</span>
                        <button
                          onClick={() =>
                            mutateEntry.mutate({
                              entry,
                              method: 'PATCH',
                              body: JSON.stringify({ enabled: !entry.enabled }),
                            })
                          }
                        >
                          {entry.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          onClick={() => {
                            setEntryTarget(entry);
                            setEntryType(entry.type);
                            setEntryValue(entry.value);
                            setEntryOpen(true);
                          }}
                        >
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => mutateEntry.mutate({ entry, method: 'DELETE' })}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                    {!visibleEntries.length ? (
                      <p className="panel-empty">No manual rules.</p>
                    ) : null}
                    {visibleEntries.length > 200 ? (
                      <p className="panel-empty">
                        Showing the first 200 matches. Refine search to narrow the list.
                      </p>
                    ) : null}
                  </div>
                </section>
              )}

              <div className="rule-set-footer-actions">
                <Button
                  variant="secondary"
                  onClick={() => action.mutate({ id: current.id, path: 'duplicate' })}
                >
                  <Copy size={14} /> Duplicate
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    action.mutate({ id: current.id, path: current.enabled ? 'disable' : 'enable' })
                  }
                >
                  {current.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button variant="danger" onClick={() => remove.mutate(current.id)}>
                  <Trash2 size={14} /> Delete
                </Button>
              </div>
            </>
          )}
        </div>
      </section>

      {formOpen ? (
        <Modal
          title={editing ? 'Edit rule set' : 'Create rule set'}
          description="Rule Sets only affect client subscription compilation."
          onClose={() => setFormOpen(false)}
        >
          <form
            className="modal-form"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate(form);
            }}
          >
            {!editing ? (
              <div className="source-choice">
                {(['MANUAL', 'REMOTE'] as const).map((sourceType) => (
                  <button
                    type="button"
                    key={sourceType}
                    className={form.sourceType === sourceType ? 'active' : ''}
                    onClick={() => setForm({ ...form, sourceType })}
                  >
                    {sourceType === 'MANUAL' ? 'Manual rules' : 'Remote HTTPS source'}
                  </button>
                ))}
              </div>
            ) : null}
            <label className="field">
              <span>Name</span>
              <input
                autoFocus
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Description</span>
              <textarea
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Format</span>
              <select
                value={form.format}
                onChange={(event) =>
                  setForm({ ...form, format: event.target.value as RuleSetFormat })
                }
              >
                {FORMATS.map((format) => (
                  <option key={format}>{format}</option>
                ))}
              </select>
            </label>
            {form.sourceType === 'REMOTE' ? (
              <>
                <label className="field">
                  <span>HTTPS source URL</span>
                  <input
                    value={form.sourceUrl}
                    onChange={(event) => setForm({ ...form, sourceUrl: event.target.value })}
                    placeholder="https://rules.example.com/list"
                  />
                </label>
                <label className="field">
                  <span>Update interval (minutes, blank for manual)</span>
                  <input
                    type="number"
                    min="5"
                    value={form.updateIntervalMinutes}
                    onChange={(event) =>
                      setForm({ ...form, updateIntervalMinutes: event.target.value })
                    }
                  />
                </label>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!form.sourceUrl || testSource.isPending}
                  onClick={() => testSource.mutate()}
                >
                  <RefreshCw size={14} /> Test source
                </Button>
              </>
            ) : null}
            <label className="enabled-toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              />
              <span>
                <b>Enabled</b>
                <small>Disabled references block compilation.</small>
              </span>
            </label>
            <div className="modal-actions">
              <Button type="button" variant="secondary" onClick={() => setFormOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  save.isPending ||
                  form.name.trim().length < 2 ||
                  (form.sourceType === 'REMOTE' && !form.sourceUrl)
                }
              >
                Save rule set
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {entryOpen ? (
        <Modal
          title={entryTarget ? 'Edit manual rule' : 'Add manual rule'}
          onClose={() => setEntryOpen(false)}
        >
          <form
            className="modal-form"
            onSubmit={(event) => {
              event.preventDefault();
              saveEntry.mutate();
            }}
          >
            <label className="field">
              <span>Type</span>
              <select
                value={entryType}
                onChange={(event) => setEntryType(event.target.value as PolicyMatchType)}
              >
                {TYPES.map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Value</span>
              <input
                autoFocus
                value={entryValue}
                onChange={(event) => setEntryValue(event.target.value)}
              />
            </label>
            <div className="modal-actions">
              <Button type="button" variant="secondary" onClick={() => setEntryOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!entryValue.trim() || saveEntry.isPending}>
                Save rule
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {importOpen ? (
        <Modal
          title="Bulk import manual rules"
          description="Parse and review before atomically replacing the current entries."
          onClose={() => setImportOpen(false)}
        >
          <div className="modal-form">
            <label className="field">
              <span>Source format</span>
              <select
                value={importFormat}
                onChange={(event) => {
                  setImportFormat(event.target.value as RuleSetFormat);
                  setImportPreview(null);
                }}
              >
                {FORMATS.map((format) => (
                  <option key={format}>{format}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Rules</span>
              <textarea
                className="rule-import"
                value={importContent}
                onChange={(event) => {
                  setImportContent(event.target.value);
                  setImportPreview(null);
                }}
                placeholder="DOMAIN_SUFFIX,example.com"
              />
            </label>
            {importPreview ? (
              <div className="import-summary">
                <b>{importPreview.parsedRules} rules</b>
                <span>{importPreview.duplicateCount} duplicates</span>
                <span>{importPreview.warnings.length} warnings</span>
                <span>{importPreview.errors.length} errors</span>
                <code>{importPreview.contentHash.slice(0, 12)}</code>
              </div>
            ) : null}
            <div className="modal-actions">
              <Button
                variant="secondary"
                disabled={!importContent || parseImport.isPending}
                onClick={() => parseImport.mutate()}
              >
                Parse preview
              </Button>
              <Button
                disabled={
                  !importPreview || importPreview.errors.length > 0 || confirmImport.isPending
                }
                onClick={() => confirmImport.mutate()}
              >
                Confirm import
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {previewTarget ? (
        <Modal
          title={`${previewTarget.name} cache preview`}
          description="Only a bounded sample is rendered."
          onClose={() => setPreviewTarget(null)}
        >
          {cachedPreview.isError ? (
            <QueryErrorState
              error={cachedPreview.error}
              onRetry={() => void cachedPreview.refetch()}
            />
          ) : cachedPreview.data ? (
            <div className="cache-preview">
              <div className="import-summary">
                <b>{cachedPreview.data.totalRules.toLocaleString()} rules</b>
                <span>{cachedPreview.data.duplicateCount} duplicates</span>
                <Status value={cachedPreview.data.status} />
              </div>
              <div className="rule-entry-table">
                {cachedPreview.data.rules.map((rule, index) => (
                  <div key={`${rule.type}-${rule.value}-${String(index)}`}>
                    <code>{rule.type}</code>
                    <span>{rule.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="screen-loader">
              <span />
            </div>
          )}
        </Modal>
      ) : null}
    </>
  );
}
