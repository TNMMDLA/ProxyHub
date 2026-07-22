import { defineConfig } from 'vitest/config';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'file:./data/proxyhub-test.db';
process.env.ENCRYPTION_KEY = 'test-encryption-key-at-least-32-bytes-long';

export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    globalSetup: ['./vitest.global.ts'],
    fileParallelism: false,
    coverage: { reporter: ['text', 'html'] },
  },
});
