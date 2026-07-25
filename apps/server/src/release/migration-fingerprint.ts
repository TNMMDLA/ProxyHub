import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const defaultMigrationsDirectory = resolve(import.meta.dirname, '../../prisma/migrations');

export async function calculateMigrationFingerprint(
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<string> {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const migrationNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const hash = createHash('sha256');
  for (const name of migrationNames) {
    const relativePath = `${name}/migration.sql`;
    const content = await readFile(resolve(migrationsDirectory, name, 'migration.sql'));
    hash.update(relativePath);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}
