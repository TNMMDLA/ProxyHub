import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar-stream';

export class SafeReaderError extends Error {
  constructor(
    readonly code:
      | 'NOT_AVAILABLE'
      | 'PATH_OUTSIDE_ROOT'
      | 'SYMLINK_FORBIDDEN'
      | 'FILE_TOO_LARGE'
      | 'INVALID_JSON'
      | 'INVALID_ARCHIVE',
    message: string,
  ) {
    super(message);
  }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

export class SafeStateReader {
  private canonicalRoot: string | undefined;

  constructor(
    private readonly root: string,
    private readonly maxBytes = 1024 * 1024,
  ) {}

  private async getRoot(): Promise<string> {
    try {
      return (this.canonicalRoot ??= await realpath(this.root));
    } catch {
      throw new SafeReaderError('NOT_AVAILABLE', 'Diagnostics directory is not available');
    }
  }

  async resolve(relativePath: string): Promise<string> {
    if (!relativePath || relativePath.includes('\0')) {
      throw new SafeReaderError('PATH_OUTSIDE_ROOT', 'Invalid diagnostics path');
    }
    const root = await this.getRoot();
    const candidate = resolve(root, relativePath);
    if (!inside(root, candidate)) {
      throw new SafeReaderError('PATH_OUTSIDE_ROOT', 'Path is outside diagnostics root');
    }
    let canonical: string;
    try {
      if ((await lstat(candidate)).isSymbolicLink()) {
        throw new SafeReaderError('SYMLINK_FORBIDDEN', 'Symbolic links are not allowed');
      }
      canonical = await realpath(candidate);
    } catch (error) {
      if (error instanceof SafeReaderError) throw error;
      throw new SafeReaderError('NOT_AVAILABLE', 'Diagnostics entry is not available');
    }
    if (!inside(root, canonical)) {
      throw new SafeReaderError('PATH_OUTSIDE_ROOT', 'Resolved path is outside diagnostics root');
    }
    return canonical;
  }

  async json(relativePath: string): Promise<Record<string, unknown>> {
    const path = await this.resolve(relativePath);
    const info = await lstat(path);
    if (!info.isFile())
      throw new SafeReaderError('NOT_AVAILABLE', 'Diagnostics entry is not a file');
    if (info.size > this.maxBytes)
      throw new SafeReaderError('FILE_TOO_LARGE', 'Diagnostics file exceeds the size limit');
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('object required');
      return value as Record<string, unknown>;
    } catch {
      throw new SafeReaderError('INVALID_JSON', 'Diagnostics file contains invalid JSON');
    }
  }

  async list(relativeDirectory: string, limit: number): Promise<string[]> {
    const path = await this.resolve(relativeDirectory);
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, limit);
  }

  async directories(relativeDirectory: string, limit: number): Promise<string[]> {
    const path = await this.resolve(relativeDirectory);
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, limit);
  }

  async archiveJson(
    relativePath: string,
    memberName: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const path = await this.resolve(relativePath);
    const info = await lstat(path);
    if (!info.isFile()) throw new SafeReaderError('NOT_AVAILABLE', 'Backup archive is not a file');

    const archive = extract();
    let result: Record<string, unknown> | undefined;
    let memberError: SafeReaderError | undefined;

    archive.on('entry', (header, stream, next) => {
      if (header.name !== memberName) {
        stream.on('end', next);
        stream.resume();
        return;
      }
      if (header.type !== 'file') {
        memberError = new SafeReaderError(
          'INVALID_ARCHIVE',
          'Backup manifest is not a regular file',
        );
        stream.on('end', next);
        stream.resume();
        return;
      }
      if ((header.size ?? 0) > this.maxBytes) {
        memberError = new SafeReaderError(
          'FILE_TOO_LARGE',
          'Backup manifest exceeds the size limit',
        );
        stream.on('end', next);
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= this.maxBytes) chunks.push(chunk);
      });
      stream.on('end', () => {
        if (bytes > this.maxBytes) {
          memberError = new SafeReaderError(
            'FILE_TOO_LARGE',
            'Backup manifest exceeds the size limit',
          );
        } else {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
            if (!value || typeof value !== 'object' || Array.isArray(value))
              throw new Error('object required');
            result = value as Record<string, unknown>;
          } catch {
            memberError = new SafeReaderError(
              'INVALID_JSON',
              'Backup manifest contains invalid JSON',
            );
          }
        }
        next();
      });
    });

    try {
      await pipeline(createReadStream(path), createGunzip(), archive, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new SafeReaderError('INVALID_ARCHIVE', 'Backup archive cannot be read');
    }
    if (memberError) throw memberError;
    if (!result) throw new SafeReaderError('INVALID_ARCHIVE', 'Backup manifest is missing');
    return result;
  }

  async files(
    limit: number,
    pattern: RegExp,
  ): Promise<Array<{ name: string; sizeBytes: number; modifiedAt: string }>> {
    const root = await this.getRoot();
    const entries = await readdir(root, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && pattern.test(entry.name))
        .slice(0, limit * 2)
        .map(async (entry) => {
          const path = await this.resolve(entry.name);
          const info = await lstat(path);
          return {
            name: basename(path),
            sizeBytes: info.size,
            modifiedAt: info.mtime.toISOString(),
          };
        }),
    );
    return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, limit);
  }
}
