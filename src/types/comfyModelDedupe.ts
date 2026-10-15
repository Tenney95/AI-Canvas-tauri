export type ComfyModelScanScope = 'models' | 'modelsAndPlugins' | 'folder' | 'disk';
export type ComfyModelScanRootKind = 'folder' | 'disk';
export type ComfyModelLinkType = 'hardlink' | 'symlink';

export interface ComfyModelScanRoot {
  rootId: string;
  displayPath: string;
  kind: ComfyModelScanRootKind;
}

export interface ComfyDuplicateModelFile {
  id: string;
  relativePath: string;
  alreadyShared: boolean;
}

export interface ComfyDuplicateModelGroup {
  id: string;
  size: number;
  hash: string;
  reclaimableBytes: number;
  files: ComfyDuplicateModelFile[];
}

export interface ComfyModelDedupeScan {
  scanId: string;
  engine: string;
  groups: ComfyDuplicateModelGroup[];
  scannedFiles: number;
  skippedFiles: number;
  warnings: string[];
  skippedEntries: Array<{ relativePath: string; reason: string }>;
  omittedSkippedEntries: number;
}

export interface ComfyModelDedupeProgress {
  stage: 'collecting' | 'hashing' | 'verifying' | 'linking';
  completed: number;
  total?: number | null;
  unit: 'files' | 'bytes';
}

export interface ComfyModelDedupeRequest {
  scanId: string;
  groupId: string;
  keeperId: string;
  targetIds: string[];
  linkType: ComfyModelLinkType;
}

export type ComfyModelDedupeGroupSelection = Omit<ComfyModelDedupeRequest, 'scanId' | 'groupId'>;
export type ComfyModelDedupeGroupRequest = Omit<ComfyModelDedupeRequest, 'scanId'>;

export interface ComfyModelDedupeBatchRequest {
  scanId: string;
  groups: ComfyModelDedupeGroupRequest[];
}

export interface ComfyModelDedupeResult {
  completed: number;
  failed: number;
  unprocessed: number;
  reclaimedBytes: number;
  message: string;
  warnings: string[];
  historyId?: string | null;
}

export interface ComfyModelDedupeRecovery {
  id: string;
  relativePath: string;
  rootLabel: string;
}

export interface ComfyModelDedupeHistoryEntry {
  id: string;
  createdAt: number;
  scope: ComfyModelScanScope;
  rootLabel: string;
  status: 'completed' | 'partial' | 'failed' | 'interrupted';
  completed: number;
  failed: number;
  unprocessed: number;
  reclaimedBytes: number;
  items: Array<{
    keeperRelativePath: string;
    targetRelativePath: string;
    hash: string;
    linkType: ComfyModelLinkType;
    size: number;
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'needsRecovery';
    reclaimedBytes: number;
    message: string | null;
  }>;
}

export interface ComfyModelDedupeHistory {
  entries: ComfyModelDedupeHistoryEntry[];
  warnings: string[];
}
