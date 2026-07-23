import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Eye,
  EyeOff,
  FileCode2,
  GripVertical,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';
import { Button, EmptyState, Modal, PageHeader, QueryErrorState, Status } from '../components/ui';
import type {
  CompilerPreviewRecord,
  PolicyAction,
  PolicyMatchSource,
  PolicyMatchType,
  PolicyRecord,
  PolicyRuleRecord,
  PoolRecord,
  RuleSetRecord,
  SubscriptionFormat,
} from '../types';

const MATCH_TYPES: PolicyMatchType[] = [
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
const ACTIONS: PolicyAction[] = ['DIRECT', 'REJECT', 'NODE_POOL'];
const FORMATS: SubscriptionFormat[] = ['mihomo', 'sing-box', 'raw'];

interface PolicyForm {
  name: string;
  description: string;
  enabled: boolean;
  defaultAction: PolicyAction;
  defaultNodePoolId: string;
}

interface RuleForm {
  name: string;
  description: string;
  enabled: boolean;
  matchSourceType: PolicyMatchSource;
  matchType: PolicyMatchType;
  matchValue: string;
  ruleSetId: string;
  actionType: PolicyAction;
  nodePoolId: string;
}

const emptyPolicy: PolicyForm = {
  name: '',
  description: '',
  enabled: true,
  defaultAction: 'DIRECT',
  defaultNodePoolId: '',
};
const emptyRule: RuleForm = {
  name: '',
  description: '',
  enabled: true,
  matchSourceType: 'INLINE',
  matchType: 'DOMAIN',
  matchValue: '',
  ruleSetId: '',
  actionType: 'DIRECT',
  nodePoolId: '',
};

function poolWarning(pool: PoolRecord | undefined): string | null {
  if (!pool) return 'Select an existing node pool.';
  if (!pool.enabled) return 'This node pool is disabled and compilation will emit a warning.';
  if (!pool.members.some((member) => member.node.enabled)) {
    return 'This node pool has no enabled nodes and compilation will fail.';
  }
  return null;
}

export default function PolicyStudioPage() {
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [policyModal, setPolicyModal] = useState(false);
  const [editingPolicyDetails, setEditingPolicyDetails] = useState(false);
  const [policyForm, setPolicyForm] = useState<PolicyForm>(emptyPolicy);
  const [ruleModal, setRuleModal] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleForm, setRuleForm] = useState<RuleForm>(emptyRule);
  const [ruleSearch, setRuleSearch] = useState('');
  const [enabledFilter, setEnabledFilter] = useState('all');
  const [actionFilter, setActionFilter] = useState('all');
  const [draggedRuleId, setDraggedRuleId] = useState<string | null>(null);
  const [format, setFormat] = useState<SubscriptionFormat>('mihomo');
  const [preview, setPreview] = useState<CompilerPreviewRecord | null>(null);
  const [revealSecrets, setRevealSecrets] = useState(false);

  const policies = useQuery({
    queryKey: ['policies'],
    queryFn: () => api<PolicyRecord[]>('/policies'),
  });
  const pools = useQuery({
    queryKey: ['node-pools'],
    queryFn: () => api<PoolRecord[]>('/node-pools'),
  });
  const ruleSets = useQuery({
    queryKey: ['rule-sets'],
    queryFn: () => api<RuleSetRecord[]>('/rule-sets'),
  });
  const activeId = selectedId ?? policies.data?.[0]?.id ?? null;
  const policy = useQuery({
    queryKey: ['policy', activeId],
    queryFn: () => api<PolicyRecord>(`/policies/${activeId}`),
    enabled: Boolean(activeId),
  });

  const invalidate = async (id?: string) => {
    await client.invalidateQueries({ queryKey: ['policies'] });
    if (id) await client.invalidateQueries({ queryKey: ['policy', id] });
  };

  const createPolicy = useMutation({
    mutationFn: (input: PolicyForm) =>
      api<PolicyRecord>('/policies', {
        method: 'POST',
        body: JSON.stringify({ ...input, defaultNodePoolId: input.defaultNodePoolId || null }),
      }),
    onSuccess: async (created) => {
      setPolicyModal(false);
      setPolicyForm(emptyPolicy);
      setSelectedId(created.id);
      await invalidate(created.id);
      toast.success('Policy created');
    },
    onError: (error) => toast.error(error.message),
  });
  const updatePolicy = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<PolicyForm> }) =>
      api<PolicyRecord>(`/policies/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...input,
          ...(input.defaultNodePoolId !== undefined
            ? { defaultNodePoolId: input.defaultNodePoolId || null }
            : {}),
        }),
      }),
    onSuccess: async (updated) => {
      await invalidate(updated.id);
      toast.success('Policy updated');
    },
    onError: (error) => toast.error(error.message),
  });
  const savePolicyDetails = useMutation({
    mutationFn: ({ id, input }: { id: string; input: PolicyForm }) =>
      api<PolicyRecord>(`/policies/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...input, defaultNodePoolId: input.defaultNodePoolId || null }),
      }),
    onSuccess: async (updated) => {
      setPolicyModal(false);
      setEditingPolicyDetails(false);
      await invalidate(updated.id);
      toast.success('Policy details updated');
    },
    onError: (error) => toast.error(error.message),
  });
  const duplicatePolicy = useMutation({
    mutationFn: (id: string) => api<PolicyRecord>(`/policies/${id}/duplicate`, { method: 'POST' }),
    onSuccess: async (created) => {
      setSelectedId(created.id);
      await invalidate(created.id);
      toast.success('Policy duplicated as disabled');
    },
    onError: (error) => toast.error(error.message),
  });
  const deletePolicy = useMutation({
    mutationFn: (id: string) => api(`/policies/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setSelectedId(null);
      setPreview(null);
      await invalidate();
      toast.success('Policy deleted');
    },
    onError: (error) => toast.error(error.message),
  });
  const saveRule = useMutation({
    mutationFn: (input: RuleForm) =>
      api<PolicyRuleRecord>(
        editingRuleId
          ? `/policies/${activeId}/rules/${editingRuleId}`
          : `/policies/${activeId}/rules`,
        {
          method: editingRuleId ? 'PATCH' : 'POST',
          body: JSON.stringify({
            ...input,
            nodePoolId: input.nodePoolId || null,
            ruleSetId: input.matchSourceType === 'RULE_SET' ? input.ruleSetId : null,
          }),
        },
      ),
    onSuccess: async () => {
      setRuleModal(false);
      setEditingRuleId(null);
      setRuleForm(emptyRule);
      setPreview(null);
      if (activeId) await invalidate(activeId);
      toast.success(editingRuleId ? 'Rule updated' : 'Rule created');
    },
    onError: (error) => toast.error(error.message),
  });
  const deleteRule = useMutation({
    mutationFn: (ruleId: string) =>
      api(`/policies/${activeId}/rules/${ruleId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setPreview(null);
      if (activeId) await invalidate(activeId);
      toast.success('Rule deleted');
    },
    onError: (error) => toast.error(error.message),
  });
  const toggleRule = useMutation({
    mutationFn: ({ ruleId, enabled }: { ruleId: string; enabled: boolean }) =>
      api(`/policies/${activeId}/rules/${ruleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: async () => {
      setPreview(null);
      if (activeId) await invalidate(activeId);
      toast.success('Rule status updated');
    },
    onError: (error) => toast.error(error.message),
  });
  const reorderRules = useMutation({
    mutationFn: (ruleIds: string[]) =>
      api(`/policies/${activeId}/rules/reorder`, {
        method: 'PUT',
        body: JSON.stringify({ ruleIds }),
      }),
    onSuccess: async () => {
      setPreview(null);
      if (activeId) await invalidate(activeId);
      toast.success('Rule priority updated');
    },
    onError: (error) => toast.error(error.message),
  });
  const compile = useMutation({
    mutationFn: (target: SubscriptionFormat) =>
      api<CompilerPreviewRecord>(`/policies/${activeId}/compile-preview`, {
        method: 'POST',
        body: JSON.stringify({ format: target }),
      }),
    onSuccess: (result) => setPreview(result),
    onError: (error) => toast.error(error.message),
  });

  const current = policy.data;
  const rules = useMemo(() => current?.rules ?? [], [current?.rules]);
  const visibleRules = useMemo(() => {
    const needle = ruleSearch.toLowerCase();
    return rules.filter(
      (rule) =>
        (!needle ||
          `${rule.name} ${rule.matchType} ${rule.matchValue} ${rule.ruleSet?.name ?? ''}`
            .toLowerCase()
            .includes(needle)) &&
        (enabledFilter === 'all' || String(rule.enabled) === enabledFilter) &&
        (actionFilter === 'all' || rule.actionType === actionFilter),
    );
  }, [actionFilter, enabledFilter, ruleSearch, rules]);

  const openRule = (rule?: PolicyRuleRecord) => {
    setEditingRuleId(rule?.id ?? null);
    setRuleForm(
      rule
        ? {
            name: rule.name,
            description: rule.description,
            enabled: rule.enabled,
            matchSourceType: rule.matchSourceType,
            matchType: rule.matchType,
            matchValue: rule.matchValue,
            ruleSetId: rule.ruleSetId ?? '',
            actionType: rule.actionType,
            nodePoolId: rule.nodePoolId ?? '',
          }
        : emptyRule,
    );
    setRuleModal(true);
  };
  const openPolicyDetails = (item: PolicyRecord) => {
    setEditingPolicyDetails(true);
    setPolicyForm({
      name: item.name,
      description: item.description,
      enabled: item.enabled,
      defaultAction: item.defaultAction,
      defaultNodePoolId: item.defaultNodePoolId ?? '',
    });
    setPolicyModal(true);
  };
  const reorder = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    const ids = rules.map((rule) => rule.id);
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const [moved] = ids.splice(from, 1);
    if (!moved) return;
    ids.splice(to, 0, moved);
    reorderRules.mutate(ids);
  };
  const moveRule = (ruleId: string, direction: -1 | 1) => {
    const ids = rules.map((rule) => rule.id);
    const index = ids.indexOf(ruleId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorderRules.mutate(ids);
  };
  const selectedRulePool = pools.data?.find((item) => item.id === ruleForm.nodePoolId);
  const selectedRuleSet = ruleSets.data?.find((item) => item.id === ruleForm.ruleSetId);
  const ruleValidation =
    ruleForm.name.trim().length < 2
      ? 'Rule name must contain at least two characters.'
      : ruleForm.matchSourceType === 'RULE_SET' && !selectedRuleSet
        ? 'Select an existing rule set.'
        : ruleForm.matchSourceType === 'INLINE' && !ruleForm.matchValue.trim()
          ? 'Match value is required.'
          : ruleForm.actionType === 'NODE_POOL'
            ? poolWarning(selectedRulePool)
            : null;

  if (policies.isError || pools.isError || ruleSets.isError) {
    const failed = policies.isError ? policies : pools.isError ? pools : ruleSets;
    return <QueryErrorState error={failed.error} onRetry={() => void failed.refetch()} />;
  }

  return (
    <>
      <PageHeader
        title="Policy Studio"
        description="One ordered policy model compiled deterministically for every supported client."
        actions={
          <Button
            onClick={() => {
              setEditingPolicyDetails(false);
              setPolicyForm(emptyPolicy);
              setPolicyModal(true);
            }}
          >
            <Plus size={16} /> Create policy
          </Button>
        }
      />
      <section className="policy-workspace">
        <aside className="policy-list-panel">
          <header>
            <div>
              <h2>Policies</h2>
              <span>{policies.data?.length ?? 0}</span>
            </div>
          </header>
          {policies.data?.length ? (
            <div className="policy-list">
              {policies.data.map((item) => (
                <button
                  key={item.id}
                  className={activeId === item.id ? 'active' : ''}
                  onClick={() => {
                    setSelectedId(item.id);
                    setPreview(null);
                  }}
                >
                  <span>
                    <b>{item.name}</b>
                    <small>
                      rev {item.revision} · {item._count.rules ?? 0} rules ·{' '}
                      {item.enabled ? 'compile ready' : 'compile blocked'}
                    </small>
                  </span>
                  <Status value={item.enabled ? 'ENABLED' : 'DISABLED'} />
                </button>
              ))}
            </div>
          ) : (
            <p className="panel-empty">Create the first unified policy.</p>
          )}
        </aside>

        <div className="policy-editor-panel">
          {!activeId ? (
            <EmptyState
              icon={<FileCode2 />}
              title="No policy selected"
              body="Create a policy to begin defining deterministic routing rules."
            />
          ) : policy.isError ? (
            <QueryErrorState error={policy.error} onRetry={() => void policy.refetch()} />
          ) : !current ? (
            <div className="screen-loader">
              <span />
            </div>
          ) : (
            <>
              <section className="policy-settings">
                <div className="policy-title-row">
                  <div>
                    <span className="eyebrow">UNIFIED POLICY · REVISION {current.revision}</span>
                    <h2>{current.name}</h2>
                    <p>{current.description || 'No description'}</p>
                  </div>
                  <div className="policy-actions">
                    <Button variant="secondary" onClick={() => openPolicyDetails(current)}>
                      <Pencil size={15} /> Edit details
                    </Button>
                    <Button variant="secondary" onClick={() => duplicatePolicy.mutate(current.id)}>
                      <Copy size={15} /> Duplicate
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        updatePolicy.mutate({
                          id: current.id,
                          input: { enabled: !current.enabled },
                        })
                      }
                    >
                      {current.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      variant="danger"
                      aria-label={`Delete ${current.name}`}
                      onClick={() => {
                        if (window.confirm(`Delete policy “${current.name}”?`))
                          deletePolicy.mutate(current.id);
                      }}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                </div>
                <div className="policy-default-row">
                  <label className="field">
                    <span>Policy name</span>
                    <input
                      value={current.name}
                      onChange={() => undefined}
                      readOnly
                      aria-label="Policy name"
                    />
                  </label>
                  <label className="field">
                    <span>Default action</span>
                    <select
                      value={current.defaultAction}
                      onChange={(event) =>
                        updatePolicy.mutate({
                          id: current.id,
                          input: {
                            defaultAction: event.target.value as PolicyAction,
                            defaultNodePoolId:
                              event.target.value === 'NODE_POOL'
                                ? (current.defaultNodePoolId ?? pools.data?.[0]?.id ?? '')
                                : '',
                          },
                        })
                      }
                    >
                      {ACTIONS.map((action) => (
                        <option key={action}>{action}</option>
                      ))}
                    </select>
                  </label>
                  {current.defaultAction === 'NODE_POOL' ? (
                    <label className="field">
                      <span>Default node pool</span>
                      <select
                        value={current.defaultNodePoolId ?? ''}
                        onChange={(event) =>
                          updatePolicy.mutate({
                            id: current.id,
                            input: { defaultNodePoolId: event.target.value },
                          })
                        }
                      >
                        <option value="">Select pool</option>
                        {pools.data?.map((pool) => (
                          <option key={pool.id} value={pool.id}>
                            {pool.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
              </section>

              <section className="rule-section">
                <div className="section-heading rule-heading">
                  <div>
                    <h2>Visual rule order</h2>
                    <p>First Match Wins. Drag cards or use arrows to change priority.</p>
                  </div>
                  <Button onClick={() => openRule()}>
                    <Plus size={15} /> Add rule
                  </Button>
                </div>
                <div className="rule-filters">
                  <label>
                    <Search size={15} />
                    <input
                      value={ruleSearch}
                      onChange={(event) => setRuleSearch(event.target.value)}
                      placeholder="Search rules..."
                    />
                  </label>
                  <select
                    value={enabledFilter}
                    onChange={(event) => setEnabledFilter(event.target.value)}
                    aria-label="Filter rule status"
                  >
                    <option value="all">All statuses</option>
                    <option value="true">Enabled</option>
                    <option value="false">Disabled</option>
                  </select>
                  <select
                    value={actionFilter}
                    onChange={(event) => setActionFilter(event.target.value)}
                    aria-label="Filter rule action"
                  >
                    <option value="all">All actions</option>
                    {ACTIONS.map((action) => (
                      <option key={action}>{action}</option>
                    ))}
                  </select>
                </div>
                {visibleRules.length ? (
                  <div className="rule-list">
                    {visibleRules.map((rule) => (
                      <article
                        key={rule.id}
                        draggable
                        onDragStart={() => setDraggedRuleId(rule.id)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={() => {
                          if (draggedRuleId) reorder(draggedRuleId, rule.id);
                          setDraggedRuleId(null);
                        }}
                      >
                        <GripVertical className="drag-handle" size={18} />
                        <strong className="rule-priority">
                          {String(rules.findIndex((item) => item.id === rule.id) + 1).padStart(
                            2,
                            '0',
                          )}
                        </strong>
                        <div className="rule-content">
                          <header>
                            <b>{rule.name}</b>
                            <Status value={rule.enabled ? 'ENABLED' : 'DISABLED'} />
                          </header>
                          <div className="rule-expression">
                            <code>
                              {rule.matchSourceType === 'RULE_SET' ? 'RULE SET' : rule.matchType}
                            </code>
                            <span>
                              {rule.matchSourceType === 'RULE_SET'
                                ? `${rule.ruleSet?.name ?? 'Missing rule set'} · ${String(rule.ruleSet?.ruleCount ?? 0)} rules · ${rule.ruleSet?.status ?? 'UNAVAILABLE'}`
                                : rule.matchValue}
                            </span>
                            <i>→</i>
                            <code>
                              {rule.actionType === 'NODE_POOL'
                                ? (rule.nodePool?.name ?? 'Missing pool')
                                : rule.actionType}
                            </code>
                          </div>
                          {rule.description ? <small>{rule.description}</small> : null}
                        </div>
                        <div className="rule-actions">
                          <button
                            aria-label={`Move ${rule.name} up`}
                            onClick={() => moveRule(rule.id, -1)}
                            disabled={rules[0]?.id === rule.id}
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            aria-label={`Move ${rule.name} down`}
                            onClick={() => moveRule(rule.id, 1)}
                            disabled={rules.at(-1)?.id === rule.id}
                          >
                            <ArrowDown size={14} />
                          </button>
                          <button aria-label={`Edit ${rule.name}`} onClick={() => openRule(rule)}>
                            <Pencil size={14} />
                          </button>
                          <button
                            aria-label={`Toggle ${rule.name}`}
                            onClick={() =>
                              toggleRule.mutate({ ruleId: rule.id, enabled: !rule.enabled })
                            }
                          >
                            {rule.enabled ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                          <button
                            aria-label={`Delete ${rule.name}`}
                            onClick={() => deleteRule.mutate(rule.id)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="panel-empty">No rules match the current filters.</p>
                )}
              </section>

              <section className="compile-panel">
                <div className="section-heading">
                  <div>
                    <h2>Compile preview</h2>
                    <p>Generated by policy-core; preview never touches Xray runtime.</p>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => compile.mutate(format)}
                    disabled={compile.isPending}
                  >
                    <FileCode2 size={15} /> {compile.isPending ? 'Compiling...' : 'Compile'}
                  </Button>
                </div>
                <div className="preview-tabs">
                  {FORMATS.map((item) => (
                    <button
                      key={item}
                      className={format === item ? 'active' : ''}
                      onClick={() => {
                        setFormat(item);
                        compile.mutate(item);
                      }}
                    >
                      {item}
                    </button>
                  ))}
                  <button
                    className="reveal-button"
                    onClick={() => setRevealSecrets((value) => !value)}
                  >
                    {revealSecrets ? <EyeOff size={14} /> : <Eye size={14} />}
                    {revealSecrets ? 'Mask credentials' : 'Show full output'}
                  </button>
                </div>
                {preview ? (
                  <>
                    <div className="compile-summary">
                      <Status value={preview.success ? 'SUCCESS' : 'FAILURE'} />
                      <span>
                        {preview.metadata.expandedRuleCount} compiled rules from{' '}
                        {preview.metadata.sourceRuleCount} policy rules and{' '}
                        {preview.metadata.ruleSetCount} rule sets · {preview.metadata.nodeCount}{' '}
                        nodes · revision {preview.metadata.revision}
                      </span>
                      <button
                        onClick={() =>
                          void navigator.clipboard.writeText(
                            revealSecrets ? preview.output : preview.maskedOutput,
                          )
                        }
                      >
                        <Copy size={14} /> Copy
                      </button>
                    </div>
                    {preview.errors.length || preview.warnings.length ? (
                      <div className="compiler-diagnostics">
                        {[...preview.errors, ...preview.warnings].map((item, index) => (
                          <div
                            key={`${item.code}-${item.ruleId ?? index}`}
                            className={preview.errors.includes(item) ? 'error' : 'warning'}
                          >
                            <b>{item.code}</b>
                            <span>
                              {item.ruleName ? `${item.ruleName}: ` : ''}
                              {item.message}
                            </span>
                            <small>
                              {item.adapter}
                              {item.ruleType ? ` · ${item.ruleType}` : ''}
                              {item.ruleSetName ? ` · ${item.ruleSetName}` : ''}
                            </small>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <pre className="config-preview">
                      <code>{revealSecrets ? preview.output : preview.maskedOutput}</code>
                    </pre>
                  </>
                ) : (
                  <p className="panel-empty">
                    Choose an adapter and compile to inspect deterministic output.
                  </p>
                )}
              </section>
            </>
          )}
        </div>
      </section>

      {policyModal ? (
        <Modal
          title={editingPolicyDetails ? 'Edit policy details' : 'Create policy'}
          description="Define one client-independent policy."
          onClose={() => setPolicyModal(false)}
        >
          <form
            className="modal-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (editingPolicyDetails && current)
                savePolicyDetails.mutate({ id: current.id, input: policyForm });
              else createPolicy.mutate(policyForm);
            }}
          >
            <label className="field">
              <span>Policy name</span>
              <input
                autoFocus
                value={policyForm.name}
                onChange={(event) => setPolicyForm({ ...policyForm, name: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Description</span>
              <textarea
                value={policyForm.description}
                onChange={(event) =>
                  setPolicyForm({ ...policyForm, description: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Default action</span>
              <select
                value={policyForm.defaultAction}
                onChange={(event) =>
                  setPolicyForm({
                    ...policyForm,
                    defaultAction: event.target.value as PolicyAction,
                  })
                }
              >
                {ACTIONS.map((action) => (
                  <option key={action}>{action}</option>
                ))}
              </select>
            </label>
            {policyForm.defaultAction === 'NODE_POOL' ? (
              <label className="field">
                <span>Default node pool</span>
                <select
                  value={policyForm.defaultNodePoolId}
                  onChange={(event) =>
                    setPolicyForm({ ...policyForm, defaultNodePoolId: event.target.value })
                  }
                >
                  <option value="">Select pool</option>
                  {pools.data?.map((pool) => (
                    <option key={pool.id} value={pool.id}>
                      {pool.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="enabled-toggle">
              <input
                type="checkbox"
                checked={policyForm.enabled}
                onChange={(event) =>
                  setPolicyForm({ ...policyForm, enabled: event.target.checked })
                }
              />
              <span>
                <b>Policy enabled</b>
                <small>Disabled policies cannot be compiled or served.</small>
              </span>
            </label>
            <div className="modal-actions">
              <Button type="button" variant="secondary" onClick={() => setPolicyModal(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  createPolicy.isPending ||
                  savePolicyDetails.isPending ||
                  policyForm.name.trim().length < 2 ||
                  (policyForm.defaultAction === 'NODE_POOL' && !policyForm.defaultNodePoolId)
                }
              >
                {editingPolicyDetails ? 'Save changes' : 'Create policy'}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {ruleModal ? (
        <Modal
          title={editingRuleId ? 'Edit policy rule' : 'Add policy rule'}
          description="Rules are evaluated in visible order using First Match Wins."
          onClose={() => setRuleModal(false)}
        >
          <form
            className="modal-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!ruleValidation || (ruleForm.actionType === 'NODE_POOL' && selectedRulePool))
                saveRule.mutate(ruleForm);
            }}
          >
            <div className="form-grid">
              <label className="field">
                <span>Rule name</span>
                <input
                  autoFocus
                  value={ruleForm.name}
                  onChange={(event) => setRuleForm({ ...ruleForm, name: event.target.value })}
                />
              </label>
              <label className="field">
                <span>Match source</span>
                <select
                  value={ruleForm.matchSourceType}
                  onChange={(event) =>
                    setRuleForm({
                      ...ruleForm,
                      matchSourceType: event.target.value as PolicyMatchSource,
                      ruleSetId: event.target.value === 'RULE_SET' ? ruleForm.ruleSetId : '',
                    })
                  }
                >
                  <option value="INLINE">Inline</option>
                  <option value="RULE_SET">Rule Set</option>
                </select>
              </label>
            </div>
            {ruleForm.matchSourceType === 'INLINE' ? (
              <div className="form-grid">
                <label className="field">
                  <span>Match type</span>
                  <select
                    value={ruleForm.matchType}
                    onChange={(event) =>
                      setRuleForm({ ...ruleForm, matchType: event.target.value as PolicyMatchType })
                    }
                  >
                    {MATCH_TYPES.map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Match value</span>
                  <input
                    value={ruleForm.matchValue}
                    onChange={(event) =>
                      setRuleForm({ ...ruleForm, matchValue: event.target.value })
                    }
                    placeholder={ruleForm.matchType === 'IP_CIDR' ? '10.0.0.0/8' : 'example.com'}
                  />
                </label>
              </div>
            ) : (
              <label className="field">
                <span>Rule Set</span>
                <select
                  value={ruleForm.ruleSetId}
                  onChange={(event) => setRuleForm({ ...ruleForm, ruleSetId: event.target.value })}
                >
                  <option value="">Select rule set</option>
                  {ruleSets.data?.map((ruleSet) => (
                    <option key={ruleSet.id} value={ruleSet.id}>
                      {ruleSet.name} · {ruleSet.ruleCount} rules · {ruleSet.status}
                    </option>
                  ))}
                </select>
                {selectedRuleSet &&
                ['STALE', 'EMPTY', 'ERROR', 'DISABLED'].includes(selectedRuleSet.status) ? (
                  <small className="validation-warning">
                    {selectedRuleSet.status === 'STALE'
                      ? 'Compilation will use the last known good cache.'
                      : `This rule set is ${selectedRuleSet.status.toLowerCase()}.`}
                  </small>
                ) : null}
              </label>
            )}
            <div className="form-grid">
              <label className="field">
                <span>Action</span>
                <select
                  value={ruleForm.actionType}
                  onChange={(event) =>
                    setRuleForm({
                      ...ruleForm,
                      actionType: event.target.value as PolicyAction,
                      nodePoolId: event.target.value === 'NODE_POOL' ? ruleForm.nodePoolId : '',
                    })
                  }
                >
                  {ACTIONS.map((action) => (
                    <option key={action}>{action}</option>
                  ))}
                </select>
              </label>
              {ruleForm.actionType === 'NODE_POOL' ? (
                <label className="field">
                  <span>Node pool</span>
                  <select
                    value={ruleForm.nodePoolId}
                    onChange={(event) =>
                      setRuleForm({ ...ruleForm, nodePoolId: event.target.value })
                    }
                  >
                    <option value="">Select pool</option>
                    {pools.data?.map((pool) => (
                      <option key={pool.id} value={pool.id}>
                        {pool.name}
                        {!pool.enabled ? ' (disabled)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div />
              )}
            </div>
            <label className="field">
              <span>Description</span>
              <textarea
                value={ruleForm.description}
                onChange={(event) => setRuleForm({ ...ruleForm, description: event.target.value })}
              />
            </label>
            <label className="enabled-toggle">
              <input
                type="checkbox"
                checked={ruleForm.enabled}
                onChange={(event) => setRuleForm({ ...ruleForm, enabled: event.target.checked })}
              />
              <span>
                <b>Rule enabled</b>
                <small>Disabled rules stay stored but are excluded from compilation.</small>
              </span>
            </label>
            {ruleValidation ? (
              <p
                className={
                  ruleForm.actionType === 'NODE_POOL' && selectedRulePool
                    ? 'validation-warning'
                    : 'validation-error'
                }
              >
                {ruleValidation}
              </p>
            ) : (
              <p className="validation-success">
                <Check size={14} /> Rule is ready to save.
              </p>
            )}
            <div className="modal-actions">
              <Button type="button" variant="secondary" onClick={() => setRuleModal(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  saveRule.isPending ||
                  Boolean(
                    ruleValidation && !(ruleForm.actionType === 'NODE_POOL' && selectedRulePool),
                  )
                }
              >
                Save rule
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
