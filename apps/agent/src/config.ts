import { z } from 'zod';

const DEVELOPMENT_AGENT_TOKEN = 'dev-agent-token-change-me';
const EXAMPLE_AGENT_TOKEN = 'replace-with-a-long-random-agent-token';

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
    XRAY_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(12_000),
  })
  .superRefine((environment, context) => {
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
