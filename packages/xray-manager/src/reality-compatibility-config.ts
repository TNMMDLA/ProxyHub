import type { ResolvedAddress } from './network-safety.js';

function pinnedDestination(address: ResolvedAddress, port: number): string {
  return `${address.family === 6 ? `[${address.address}]` : address.address}:${String(port)}`;
}

export function buildRealityCompatibilityConfigs(options: {
  serverName: string;
  targetAddress: ResolvedAddress;
  targetPort: number;
  serverPort: number;
  proxyPort: number;
  uuid: string;
  privateKey: string;
  publicKey: string;
  shortId: string;
}): { server: Record<string, unknown>; client: Record<string, unknown> } {
  return {
    server: {
      log: { loglevel: 'warning' },
      inbounds: [
        {
          tag: 'compat-reality-server',
          listen: '127.0.0.1',
          port: options.serverPort,
          protocol: 'vless',
          settings: {
            clients: [{ id: options.uuid, flow: 'xtls-rprx-vision' }],
            decryption: 'none',
          },
          streamSettings: {
            network: 'tcp',
            security: 'reality',
            realitySettings: {
              show: false,
              dest: pinnedDestination(options.targetAddress, options.targetPort),
              xver: 0,
              serverNames: [options.serverName],
              privateKey: options.privateKey,
              shortIds: [options.shortId],
            },
          },
        },
      ],
      outbounds: [{ tag: 'direct', protocol: 'freedom' }],
    },
    client: {
      log: { loglevel: 'warning' },
      inbounds: [
        {
          tag: 'compat-socks',
          listen: '127.0.0.1',
          port: options.proxyPort,
          protocol: 'socks',
          settings: { auth: 'noauth', udp: false },
        },
      ],
      outbounds: [
        {
          tag: 'compat-reality-client',
          protocol: 'vless',
          settings: {
            vnext: [
              {
                address: '127.0.0.1',
                port: options.serverPort,
                users: [
                  {
                    id: options.uuid,
                    encryption: 'none',
                    flow: 'xtls-rprx-vision',
                  },
                ],
              },
            ],
          },
          streamSettings: {
            network: 'tcp',
            security: 'reality',
            realitySettings: {
              serverName: options.serverName,
              fingerprint: 'chrome',
              password: options.publicKey,
              shortId: options.shortId,
              spiderX: '/',
            },
          },
        },
      ],
    },
  };
}
