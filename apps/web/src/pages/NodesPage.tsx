import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  CopyPlus,
  Pencil,
  Plus,
  Power,
  PowerOff,
  QrCode,
  RadioTower,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { RealityTargetCompatibilityResult } from '@proxyhub/shared';
import { api } from '../api';
import {
  Button,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  QueryErrorState,
  Status,
} from '../components/ui';
import type { NodeRecord, ServerRecord } from '../types';
import { RealityCompatibilityPanel } from './RealityCompatibilityPanel';
import {
  clearCompatibilityOnRealityChange,
  initialForm,
  type CompatibilityView,
} from './reality-compatibility-state';

export default function NodesPage() {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(params.get('create') === '1');
  const [share, setShare] = useState<{ uri: string; qrCode: string } | null>(null);
  const [form, setForm] = useState(initialForm);
  const [createCompatibility, setCreateCompatibility] = useState<CompatibilityView>(null);
  const [editCompatibility, setEditCompatibility] = useState<CompatibilityView>(null);
  const [editing, setEditing] = useState<
    Pick<NodeRecord, 'id' | 'name' | 'host' | 'port' | 'sni' | 'dest' | 'fingerprint'> | undefined
  >();
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<NodeRecord[]>('/nodes') });
  const servers = useQuery({
    queryKey: ['servers'],
    queryFn: () => api<ServerRecord[]>('/servers'),
  });
  const openCreate = () => {
    const server = servers.data?.[0];
    setForm((value) => (server ? { ...value, serverId: server.id, host: server.ip } : value));
    setCreateCompatibility(null);
    setCreateOpen(true);
  };
  const closeCreate = () => {
    setCreateOpen(false);
    setCreateCompatibility(null);
    setParams({});
  };
  const createCompatibilityTest = useMutation({
    mutationFn: () =>
      api<RealityTargetCompatibilityResult>('/nodes/reality-compatibility', {
        method: 'POST',
        body: JSON.stringify({ serverName: form.sni, target: form.dest }),
      }),
    onSuccess: setCreateCompatibility,
    onError: (error) => setCreateCompatibility({ status: 'ERROR', message: error.message }),
  });
  const editCompatibilityTest = useMutation({
    mutationFn: (node: NonNullable<typeof editing>) =>
      api<RealityTargetCompatibilityResult>('/nodes/reality-compatibility', {
        method: 'POST',
        body: JSON.stringify({ serverName: node.sni, target: node.dest }),
      }),
    onSuccess: setEditCompatibility,
    onError: (error) => setEditCompatibility({ status: 'ERROR', message: error.message }),
  });
  const create = useMutation({
    mutationFn: () => {
      const serverId = form.serverId || servers.data?.[0]?.id || '';
      return api<NodeRecord>('/nodes', {
        method: 'POST',
        body: JSON.stringify({ ...form, serverId }),
      });
    },
    onSuccess: () => {
      toast.success('Reality node created and validated');
      closeCreate();
      setForm(initialForm);
      void client.invalidateQueries({ queryKey: ['nodes'] });
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/nodes/${id}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['nodes'] }),
    onError: (error) => toast.error(error.message),
  });
  const update = useMutation({
    mutationFn: (node: NonNullable<typeof editing>) =>
      api<NodeRecord>(`/nodes/${node.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: node.name,
          host: node.host,
          port: node.port,
          sni: node.sni,
          dest: node.dest,
          fingerprint: node.fingerprint,
        }),
      }),
    onSuccess: () => {
      toast.success('Reality node updated and validated');
      setEditing(undefined);
      void client.invalidateQueries({ queryKey: ['nodes'] });
    },
    onError: (error) => toast.error(error.message),
  });
  const clone = useMutation({
    mutationFn: (id: string) => api<NodeRecord>(`/nodes/${id}/clone`, { method: 'POST' }),
    onSuccess: (node) => {
      toast.success(`${node.name} created with fresh credentials`);
      void client.invalidateQueries({ queryKey: ['nodes'] });
    },
    onError: (error) => toast.error(error.message),
  });
  const toggle = useMutation({
    mutationFn: (node: NodeRecord) =>
      api<NodeRecord>(`/nodes/${node.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !node.enabled }),
      }),
    onSuccess: (node) => {
      toast.success(`${node.name} ${node.enabled ? 'enabled' : 'disabled'} and synchronized`);
      void client.invalidateQueries({ queryKey: ['nodes'] });
    },
    onError: (error) => toast.error(error.message),
  });
  const getShare = (id: string) => api<{ uri: string; qrCode: string }>(`/nodes/${id}/share`);
  const openShare = async (id: string) => {
    try {
      setShare(await getShare(id));
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  const copyUri = async (id: string) => {
    try {
      const result = await getShare(id);
      await navigator.clipboard.writeText(result.uri);
      toast.success('URI copied');
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  if (nodes.isError || servers.isError) {
    const failedQuery = nodes.isError ? nodes : servers;
    return (
      <QueryErrorState
        error={failedQuery.error}
        onRetry={() => {
          void nodes.refetch();
          void servers.refetch();
        }}
      />
    );
  }
  return (
    <>
      <PageHeader
        title="Nodes"
        description="VLESS Reality entry points with encrypted credentials and validated configuration."
        actions={
          <Button onClick={openCreate}>
            <Plus size={16} />
            Create node
          </Button>
        }
      />
      {nodes.data?.length ? (
        <section className="table-panel">
          <div className="responsive-table">
            <table>
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Server</th>
                  <th>Endpoint</th>
                  <th>Status</th>
                  <th>Latency</th>
                  <th>Pools</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {nodes.data.map((node) => (
                  <tr key={node.id}>
                    <td>
                      <span className="name-cell">
                        <i className={node.enabled ? '' : 'disabled'} />
                        <b>{node.name}</b>
                        <small>VLESS · Reality · Vision</small>
                      </span>
                    </td>
                    <td>{node.server.name}</td>
                    <td className="mono">
                      {node.host}:{node.port}
                    </td>
                    <td>
                      <Status value={node.status} />
                    </td>
                    <td>{node.latency ? `${node.latency} ms` : 'Not checked'}</td>
                    <td>{node.pools.length}</td>
                    <td>
                      <div className="row-actions">
                        <button title="Share" onClick={() => void openShare(node.id)}>
                          <QrCode size={16} />
                        </button>
                        <button title="Copy URI" onClick={() => void copyUri(node.id)}>
                          <Copy size={16} />
                        </button>
                        <button
                          title="Edit"
                          onClick={() => {
                            setEditCompatibility(null);
                            setEditing({
                              id: node.id,
                              name: node.name,
                              host: node.host,
                              port: node.port,
                              sni: node.sni,
                              dest: node.dest,
                              fingerprint: node.fingerprint,
                            });
                          }}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          title="Clone"
                          disabled={clone.isPending}
                          onClick={() => clone.mutate(node.id)}
                        >
                          <CopyPlus size={16} />
                        </button>
                        <button
                          title={node.enabled ? 'Disable' : 'Enable'}
                          disabled={toggle.isPending}
                          onClick={() => toggle.mutate(node)}
                        >
                          {node.enabled ? <PowerOff size={16} /> : <Power size={16} />}
                        </button>
                        <button
                          title="Delete"
                          onClick={() => {
                            if (confirm(`Delete ${node.name}?`)) remove.mutate(node.id);
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <EmptyState
          icon={<RadioTower />}
          title="No nodes yet"
          body="Create a VLESS Reality node. ProxyHub will generate UUID, X25519 keys and Short ID automatically."
          action={
            <Button onClick={openCreate}>
              <Plus size={16} />
              Create first node
            </Button>
          }
        />
      )}
      {createOpen ? (
        <Modal
          title="Create VLESS Reality node"
          description="Quick mode generates cryptographic fields securely."
          onClose={closeCreate}
        >
          <form
            className="modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="form-grid">
              <Input
                label="Node name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Tokyo Edge"
                required
              />
              <label className="field">
                <span>Server</span>
                <select
                  value={form.serverId || servers.data?.[0]?.id || ''}
                  onChange={(e) => setForm({ ...form, serverId: e.target.value })}
                >
                  {servers.data?.map((server) => (
                    <option key={server.id} value={server.id}>
                      {server.name}
                    </option>
                  ))}
                </select>
              </label>
              <Input
                label="Public host or IP"
                value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
                required
              />
              <Input
                label="Port"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
                required
              />
              <Input
                label="SNI"
                value={form.sni}
                onChange={(event) => {
                  const next = clearCompatibilityOnRealityChange(form, 'sni', event.target.value);
                  setForm(next.form);
                  setCreateCompatibility(next.compatibility);
                }}
                required
              />
              <Input
                label="Reality target"
                value={form.dest}
                onChange={(event) => {
                  const next = clearCompatibilityOnRealityChange(form, 'dest', event.target.value);
                  setForm(next.form);
                  setCreateCompatibility(next.compatibility);
                }}
                required
              />
            </div>
            <div className="compatibility-action">
              <Button
                type="button"
                variant="secondary"
                disabled={createCompatibilityTest.isPending}
                onClick={() => createCompatibilityTest.mutate()}
              >
                <ShieldCheck size={16} />
                {createCompatibilityTest.isPending
                  ? 'Testing live Reality tunnel…'
                  : 'Test Reality compatibility'}
              </Button>
              <small>The backend runs this live preflight again when the node is created.</small>
            </div>
            <RealityCompatibilityPanel result={createCompatibility} />
            <div className="generated-note">
              <b>Generated on save</b>
              <span>UUID · X25519 keypair · Short ID · xtls-rprx-vision flow</span>
            </div>
            <div className="modal-actions">
              <Button type="button" variant="secondary" onClick={closeCreate}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Validating…' : 'Create & validate'}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
      {share ? (
        <Modal
          title="Share node"
          description="Import this URI into a compatible VLESS client."
          onClose={() => setShare(null)}
        >
          <div className="share-content">
            <img src={share.qrCode} alt="VLESS URI QR code" />
            <code>{share.uri}</code>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(share.uri);
                toast.success('URI copied');
              }}
            >
              <Copy size={16} />
              Copy URI
            </Button>
          </div>
        </Modal>
      ) : null}
      {editing ? (
        <Modal
          title="Edit VLESS Reality node"
          description="Changes are validated against the complete Reality inbound before saving."
          onClose={() => setEditing(undefined)}
        >
          <form
            className="modal-form"
            onSubmit={(event) => {
              event.preventDefault();
              update.mutate(editing);
            }}
          >
            <div className="form-grid">
              <Input
                label="Node name"
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                required
              />
              <Input
                label="Public host or IP"
                value={editing.host}
                onChange={(event) => setEditing({ ...editing, host: event.target.value })}
                required
              />
              <Input
                label="Port"
                type="number"
                min={1}
                max={65535}
                value={editing.port}
                onChange={(event) => setEditing({ ...editing, port: Number(event.target.value) })}
                required
              />
              <Input
                label="SNI"
                value={editing.sni}
                onChange={(event) => {
                  const next = clearCompatibilityOnRealityChange(
                    editing,
                    'sni',
                    event.target.value,
                  );
                  setEditing(next.form);
                  setEditCompatibility(next.compatibility);
                }}
                required
              />
              <Input
                label="Reality target"
                value={editing.dest}
                onChange={(event) => {
                  const next = clearCompatibilityOnRealityChange(
                    editing,
                    'dest',
                    event.target.value,
                  );
                  setEditing(next.form);
                  setEditCompatibility(next.compatibility);
                }}
                required
              />
              <Input
                label="Fingerprint"
                value={editing.fingerprint}
                onChange={(event) => setEditing({ ...editing, fingerprint: event.target.value })}
                required
              />
            </div>
            <div className="compatibility-action">
              <Button
                type="button"
                variant="secondary"
                disabled={editCompatibilityTest.isPending}
                onClick={() => editCompatibilityTest.mutate(editing)}
              >
                <ShieldCheck size={16} />
                {editCompatibilityTest.isPending
                  ? 'Testing live Reality tunnel…'
                  : 'Test Reality compatibility'}
              </Button>
              <small>Saving SNI or target changes always triggers a fresh backend preflight.</small>
            </div>
            <RealityCompatibilityPanel result={editCompatibility} />
            <div className="modal-actions">
              <Button type="button" variant="secondary" onClick={() => setEditing(undefined)}>
                Cancel
              </Button>
              <Button type="submit" disabled={update.isPending}>
                {update.isPending ? 'Validating…' : 'Save changes'}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
