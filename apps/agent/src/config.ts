import { z } from 'zod';

const DEVELOPMENT_AGENT_TOKEN = 'dev-agent-token-change-me';
const EXAMPLE_AGENT_TOKEN = 'replace-with-a-long-random-agent-token';

const booleanFromEnvironment = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  if (value.toLowerCase() === 'true' || value === '1') return true;
  if (value.toLowerCase() === 'false' || value === '0') return false;
  return value;
}, z.boolean());

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    AGENT_HOST: z.string().default('0.0.0.0'),
    AGENT_PORT: z.coerce.number().int().positive().default(3001),
    AGENT_TOKEN: z.string().min(16).default(DEVELOPMENT_AGENT_TOKEN),
    XRAY_BINARY: z.string().default('/usr/local/bin/xray'),
    XRAY_CONFIG_PATH: z.string().default('/etc/xray/config.json'),
    XRAY_RESTART_SIGNAL: z.string().default('/var/run/proxyhub/restart'),
    XRAY_APPLIED_PATH: z.string().default('/var/run/proxyhub/applied'),
    XRAY_PID_PATH: z.string().default('/var/run/proxyhub/xray.pid'),
    XRAY_HEARTBEAT_PATH: z.string().default('/var/run/proxyhub/xray.heartbeat'),
    XRAY_PROBE_HOST: z.string().default('127.0.0.1'),
    XRAY_METRICS_URL: z.string().url().default('http://host.docker.internal:11111/debug/vars'),
    XRAY_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(12_000),
    REALITY_COMPATIBILITY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(60_000)
      .default(20_000),
    PROXYHUB_NETWORK_PERF_TARGETS_JSON: z.string().optional(),
    PROXYHUB_NETWORK_PERF_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(300_000)
      .default(120_000),
    PROXYHUB_NETWORK_PERF_TARGET_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(60_000)
      .default(20_000),
    PROXYHUB_NETWORK_PERF_NODE_HOST: z.string().trim().min(1).max(253).default('127.0.0.1'),
    PROXYHUB_NETWORK_PERF_TEST_MODE: booleanFromEnvironment.default(false),
  })
  .superRefine((environment, context) => {
    const metricsUrl = new URL(environment.XRAY_METRICS_URL);
    if (
      metricsUrl.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', 'host.docker.internal'].includes(metricsUrl.hostname) ||
      metricsUrl.port !== '11111' ||
      metricsUrl.pathname !== '/debug/vars' ||
      metricsUrl.search !== '' ||
      metricsUrl.hash !== '' ||
      metricsUrl.username !== '' ||
      metricsUrl.password !== ''
    ) {
      context.addIssue({
        code: 'custom',
        path: ['XRAY_METRICS_URL'],
        message: 'XRAY_METRICS_URL must use the internal Xray HTTP metrics endpoint',
      });
    }
    if (
      environment.NODE_ENV === 'production' &&
      (environment.AGENT_TOKEN === DEVELOPMENT_AGENT_TOKEN ||
        environment.AGENT_TOKEN === EXAMPLE_AGENT_TOKEN)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['AGENT_TOKEN'],
        message: 'AGENT_TOKEN must be replaced with a unique production secret',
      });
    }
  });

export type AgentConfig = z.infer<typeof envSchema>;
export function parseAgentConfig(environment: NodeJS.ProcessEnv): AgentConfig {
  return envSchema.parse(environment);
}
