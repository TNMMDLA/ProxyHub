export interface ReleaseImage {
  repository: string;
  tag: string;
  digest: string | null;
}

export interface ReleaseManifest {
  schemaVersion: number;
  releaseId: string;
  version: string;
  gitSha: string;
  gitShortSha: string;
  buildTime: string;
  buildEnvironment: 'ci' | 'development' | 'production';
  deployMode: 'image' | 'source';
  xrayVersion: string;
  databaseMigrationFingerprint: string;
  images: {
    web: ReleaseImage;
    server: ReleaseImage;
    agent: ReleaseImage;
    xray: ReleaseImage;
  };
}

export const root: string;

export function readReleaseVersion(): Promise<{
  version: string;
  xrayVersion: string;
  manifestSchemaVersion: number;
}>;

export function compareReleaseVersions(left: string, right: string): number;

export function nextPatchDevelopmentVersion(version: string): string;

export function previousCoreVersion(version: string): string;

export function migrationFingerprint(directory?: string): Promise<string>;

export function validateReleaseManifest(
  manifest: unknown,
  options?: { requireDigests?: boolean },
): Promise<ReleaseManifest>;

export function createReleaseManifest(options: {
  gitSha: string;
  buildTime?: string;
  buildEnvironment?: 'ci' | 'development' | 'production';
  deployMode?: 'image' | 'source';
  imagePrefix?: string;
  tag?: string;
  migrationsPath?: string;
  mode?: 'dry-run' | 'release';
  digests?: Partial<Record<'web' | 'server' | 'agent' | 'xray', string | null>>;
}): Promise<ReleaseManifest>;

export function parseArguments(arguments_: string[]): Record<string, string>;
