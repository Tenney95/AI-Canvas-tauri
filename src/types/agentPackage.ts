/**
 * User-installed Agent Package contracts.
 *
 * Package definitions and installation records are global. Project records may
 * reference an installation later, but never persist the source path or package
 * contents.
 */

export type AgentPackageScope = 'global' | 'project' | 'series';
export type AgentPackageSurface = 'assistant' | 'canvas' | 'background' | 'mcp';
export type AgentPackageSourceType = 'folder' | 'archive';
export type AgentPackageHealth = 'ready' | 'degraded' | 'invalid' | 'missing';
export type AgentCatalogStatus = 'idle' | 'loading' | 'ready' | 'degraded';

export interface AgentPackageEntrypoints {
  instructions: string;
  router?: string;
}

export interface AgentPackageRouting {
  userInvocable: boolean;
  autoInvoke: boolean;
  whenToUse?: string;
  triggers?: string[];
}

export interface AgentPackageContributions {
  skillRoots?: string[];
  knowledgeRoots?: string[];
  assetRoots?: string[];
  requestedTools?: string[];
  excludePaths?: string[];
}

/** Normalized v1 manifest read from ai-canvas-agent.json. */
export interface AgentPackageManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  entrypoints: AgentPackageEntrypoints;
  supportedScopes: AgentPackageScope[];
  supportedSurfaces: AgentPackageSurface[];
  routing: AgentPackageRouting;
  contributes?: AgentPackageContributions;
}

/**
 * Sanitized native preview. The Rust side owns the real source path and returns
 * only an opaque sourceId plus bounded metadata to the renderer.
 */
export interface AgentSourcePreview {
  sourceId: string;
  sourceType: AgentPackageSourceType;
  name: string;
  version: string;
  /** Raw JSON value from the source manifest; null means it could not be loaded. */
  manifest: unknown | null;
  /** Discovered package-relative entry files, normalized with `/` separators. */
  entrypoints: string[];
  instructionText: string;
  skillCount: number;
  fileCount: number;
  totalBytes: number;
  warnings: string[];
  health: AgentPackageHealth;
  contentHash: string;
}

/** Renderer-validated native preview used by the installation Store. */
export interface NormalizedAgentSourcePreview extends Omit<AgentSourcePreview, 'manifest'> {
  manifest: AgentPackageManifest | null;
}

export interface AgentPackageSourceReference {
  sourceId: string;
  sourceType: AgentPackageSourceType;
  displayName: string;
}

/** Global, renderer-safe installation record stored in the optional catalog DB. */
export interface AgentPackageInstallation {
  id: string;
  packageId: string;
  manifest: AgentPackageManifest;
  source: AgentPackageSourceReference;
  entrypoints: string[];
  skillCount: number;
  fileCount: number;
  totalBytes: number;
  warnings: string[];
  health: AgentPackageHealth;
  contentHash: string;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
}
