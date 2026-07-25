import { z } from 'zod';

const DEVELOPMENT_ENCRYPTION_KEY = 'dev-only-change-this-32-byte-key!!';
const DEVELOPMENT_AGENT_TOKEN = 'dev-agent-token-change-me';
const EXAMPLE_ENCRYPTION_KEY = 'replace-with-at-least-32-random-characters';
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
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().default('file:./data/proxyhub.db'),
    WEB_ORIGIN: z.string().default('http://localhost:5173'),
    SESSION_COOKIE_NAME: z.string().default('proxyhub_session'),
    SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),
    ENCRYPTION_KEY: z.string().min(32).default(DEVELOPMENT_ENCRYPTION_KEY),
    XRAY_BINARY: z.string().default('/usr/local/bin/xray'),
    AGENT_URL: z.string().url().default('http://localhost:3001'),
    AGENT_TOKEN: z.string().min(16).default(DEVELOPMENT_AGENT_TOKEN),
    TRUST_PROXY: booleanFromEnvironment.default(false),
    RULE_SET_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(5 * 1024 * 1024),
    RULE_SET_MAX_RULES: z.coerce.number().int().min(100).max(200_000).default(50_000),
    RULE_SET_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
    RULE_SET_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(3),
    RULE_SET_ALLOW_HTTP: booleanFromEnvironment.default(false),
    PROXYHUB_DIAGNOSTICS_ENABLED: booleanFromEnvironment.default(true),
    PROXYHUB_DIAGNOSTICS_CACHE_TTL_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(60_000)
      .default(10_000),
    PROXYHUB_DIAGNOSTICS_DEEP_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(60_000)
      .default(30_000),
    PROXYHUB_DIAGNOSTICS_MAX_HISTORY: z.coerce.number().int().min(1).max(100).default(20),
    PROXYHUB_DIAGNOSTICS_MAX_BACKUPS: z.coerce.number().int().min(1).max(200).default(50),
    PROXYHUB_STATE_DIR: z.string().default('/var/lib/proxyhub/state'),
    PROXYHUB_BACKUP_DIR: z.string().default('/var/lib/proxyhub/backups'),
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV !== 'production') return;
    if (
      environment.ENCRYPTION_KEY === DEVELOPMENT_ENCRYPTION_KEY ||
      environment.ENCRYPTION_KEY === EXAMPLE_ENCRYPTION_KEY
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ENCRYPTION_KEY'],
        message: 'ENCRYPTION_KEY must be replaced with a unique production secret',
      });
    }
    if (
      environment.AGENT_TOKEN === DEVELOPMENT_AGENT_TOKEN ||
      environment.AGENT_TOKEN === EXAMPLE_AGENT_TOKEN
    ) {
      context.addIssue({
        code: 'custom',
        path: ['AGENT_TOKEN'],
        message: 'AGENT_TOKEN must be replaced with a unique production secret',
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;
export function parseConfig(environment: NodeJS.ProcessEnv): AppConfig {
  return envSchema.parse(environment);
}

export const config = parseConfig(process.env);
