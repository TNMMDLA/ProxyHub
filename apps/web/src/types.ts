export interface Admin {
  id: string;
  username: string;
  role: string;
  totpEnabled: boolean;
}
export interface ServerRecord {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  region: string;
  status: string;
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
  lastHeartbeat: string | null;
  xrayVersion: string | null;
  _count?: { nodes: number };
}
export interface NodeRecord {
  id: string;
  serverId: string;
  name: string;
  host: string;
  port: number;
  uuid: string;
  flow: string;
  realityPublicKey: string;
  shortId: string;
  sni: string;
  dest: string;
  fingerprint: string;
  status: string;
  enabled: boolean;
  latency: number | null;
  createdAt: string;
  server: { name: string; status: string };
  pools: Array<{ nodePool: PoolRecord }>;
}
export interface PoolRecord {
  id: string;
  name: string;
  description: string;
  region: string;
  strategy: string;
  enabled: boolean;
  members: Array<{ node: Pick<NodeRecord, 'id' | 'name' | 'status' | 'enabled' | 'latency'> }>;
}
export interface NotificationRecord {
  id: string;
  level: string;
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}
export interface AuditRecord {
  id: string;
  actorName: string;
  action: string;
  resource: string;
  resourceId: string | null;
  ip: string | null;
  result: string;
  createdAt: string;
}
