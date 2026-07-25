import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { pack } from 'tar-stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeReaderError, SafeStateReader } from './safe-reader.js';

let root: string;
let outside: string;

async function createArchive(
  path: string,
  entries: Array<{ name: string; body: string }>,
): Promise<void> {
  const archive = pack();
  for (const entry of entries) archive.entry({ name: entry.name }, entry.body);
  archive.finalize();
  await pipeline(archive, createGzip(), createWriteStream(path));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'proxyhub-diagnostics-state-'));
  outside = await mkdtemp(join(tmpdir(), 'proxyhub-diagnostics-outside-'));
  await mkdir(join(root, 'history'));
  await writeFile(join(root, 'current.json'), '{"version":"0.3.1-dev"}');
  await writeFile(join(root, 'history', 'one.json'), '{"currentStage":"COMPLETED"}');
  await writeFile(join(root, 'history', 'two.json'), '{"currentStage":"FAILED"}');
  await writeFile(join(outside, 'secret.json'), '{"token":"must-not-read"}');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('SafeStateReader', () => {
  it('reads a valid object', async () =>
    expect(await new SafeStateReader(root).json('current.json')).toEqual({
      version: '0.3.1-dev',
    }));
  it('lists valid JSON files', async () =>
    expect(await new SafeStateReader(root).list('history', 10)).toEqual(['two.json', 'one.json']));
  it('enforces the history limit', async () =>
    expect(await new SafeStateReader(root).list('history', 1)).toHaveLength(1));
  it('rejects parent traversal', async () =>
    expect(new SafeStateReader(root).json('../secret.json')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ROOT',
    }));
  it('rejects nested parent traversal', async () =>
    expect(new SafeStateReader(root).json('history/../../secret.json')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ROOT',
    }));
  it('rejects an absolute outside path', async () =>
    expect(new SafeStateReader(root).json(join(outside, 'secret.json'))).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ROOT',
    }));
  it.skipIf(process.platform === 'win32')('rejects a direct file symlink', async () => {
    await symlink(join(outside, 'secret.json'), join(root, 'linked.json'));
    await expect(new SafeStateReader(root).json('linked.json')).rejects.toMatchObject({
      code: 'SYMLINK_FORBIDDEN',
    });
  });
  it('rejects a directory symlink escape', async () => {
    await symlink(outside, join(root, 'linked-dir'), 'junction');
    await expect(new SafeStateReader(root).json('linked-dir/secret.json')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ROOT',
    });
  });
  it('rejects an oversized file', async () => {
    await writeFile(join(root, 'large.json'), JSON.stringify({ value: 'x'.repeat(100) }));
    await expect(new SafeStateReader(root, 20).json('large.json')).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
  });
  it('rejects invalid JSON', async () => {
    await writeFile(join(root, 'broken.json'), '{');
    await expect(new SafeStateReader(root).json('broken.json')).rejects.toMatchObject({
      code: 'INVALID_JSON',
    });
  });
  it('rejects JSON arrays', async () => {
    await writeFile(join(root, 'array.json'), '[]');
    await expect(new SafeStateReader(root).json('array.json')).rejects.toMatchObject({
      code: 'INVALID_JSON',
    });
  });
  it('reports a missing root as unavailable', async () =>
    expect(new SafeStateReader(join(root, 'missing')).json('current.json')).rejects.toMatchObject({
      code: 'NOT_AVAILABLE',
    }));
  it('reports a missing file as unavailable', async () =>
    expect(new SafeStateReader(root).json('missing.json')).rejects.toMatchObject({
      code: 'NOT_AVAILABLE',
    }));
  it('lists only recognized backup metadata without paths', async () => {
    await writeFile(join(root, 'proxyhub-backup-20260101T000000Z-abcdef.tar.gz'), 'fixture');
    await writeFile(join(root, 'unknown.zip'), 'fixture');
    const files = await new SafeStateReader(root).files(
      10,
      /^proxyhub-backup-\d+T\d+Z-[0-9a-f]+\.tar\.gz$/,
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe('proxyhub-backup-20260101T000000Z-abcdef.tar.gz');
    expect(JSON.stringify(files)).not.toContain(root);
  });
  it('streams a JSON manifest from a backup archive', async () => {
    const path = join(root, 'proxyhub-backup-20260101T000000Z-abcdef.tar.gz');
    await createArchive(path, [
      { name: 'database.sqlite', body: 'fixture' },
      { name: 'manifest.json', body: '{"schemaVersion":1,"encryptionKeyIncluded":false}' },
    ]);
    await expect(
      new SafeStateReader(root).archiveJson(
        'proxyhub-backup-20260101T000000Z-abcdef.tar.gz',
        'manifest.json',
      ),
    ).resolves.toEqual({ schemaVersion: 1, encryptionKeyIncluded: false });
  });
  it('rejects a missing backup manifest', async () => {
    const path = join(root, 'proxyhub-backup-20260101T000000Z-abcdef.tar.gz');
    await createArchive(path, [{ name: 'README.txt', body: 'fixture' }]);
    await expect(
      new SafeStateReader(root).archiveJson(
        'proxyhub-backup-20260101T000000Z-abcdef.tar.gz',
        'manifest.json',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
  });
  it('rejects an oversized backup manifest without extracting files', async () => {
    const path = join(root, 'proxyhub-backup-20260101T000000Z-abcdef.tar.gz');
    await createArchive(path, [
      { name: 'manifest.json', body: JSON.stringify({ x: 'x'.repeat(100) }) },
    ]);
    await expect(
      new SafeStateReader(root, 20).archiveJson(
        'proxyhub-backup-20260101T000000Z-abcdef.tar.gz',
        'manifest.json',
      ),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });
  it('uses stable error codes', () =>
    expect(new SafeReaderError('PATH_OUTSIDE_ROOT', 'unsafe').code).toBe('PATH_OUTSIDE_ROOT'));
});
