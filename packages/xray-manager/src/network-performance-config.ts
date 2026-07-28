export interface NetworkPerformanceNodeCredentials {
  address: string;
  port: number;
  uuid: string;
  flow: string;
  sni: string;
  publicKey: string;
  shortId: string;
  fingerprint: string;
}

export function buildNetworkPerformanceClientConfig(options: {
  socksPort: number;
  node: NetworkPerformanceNodeCredentials;
}): Record<string, unknown> {
  if (options.socksPort < 1 || options.socksPort > 65_535) {
    throw new Error('Invalid temporary SOCKS port');
  }
  if (options.node.port < 1 || options.node.port > 65_535) {
    throw new Error('Invalid node port');
  }
  if (
    !options.node.address ||
    !options.node.uuid ||
    !options.node.sni ||
    !options.node.publicKey ||
    !options.node.shortId
  ) {
    throw new Error('Missing VLESS Reality performance-test field');
  }
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'network-performance-socks',
        listen: '127.0.0.1',
        port: options.socksPort,
        protocol: 'socks',
        settings: { auth: 'noauth', udp: false },
      },
    ],
    outbounds: [
      {
        tag: 'network-performance-reality',
        protocol: 'vless',
        settings: {
          vnext: [
            {
              address: options.node.address,
              port: options.node.port,
              users: [
                {
                  id: options.node.uuid,
                  encryption: 'none',
                  flow: options.node.flow,
                },
              ],
            },
          ],
        },
        streamSettings: {
          network: 'tcp',
          security: 'reality',
          realitySettings: {
            serverName: options.node.sni,
            fingerprint: options.node.fingerprint,
            password: options.node.publicKey,
            shortId: options.node.shortId,
            spiderX: '/',
          },
        },
      },
      { tag: 'blocked', protocol: 'blackhole' },
    ],
  };
}
