import type { DirectorRuntimeKind } from './directorScene';
import type {
  DirectorBlenderJobStatus,
  DirectorBlenderOperation,
} from '../services/directorBlenderRuntimeService';

/** 仅用于主窗口内存运行时，不进入节点或 IndexedDB。 */
export type DirectorOperationOwner =
  | { source: 'ui'; projectId: string }
  | { source: 'mcp'; projectId: string; conversationId: string; taskId: string };

export type DirectorSceneSource = 'director-scene' | 'saved-blender';

export interface DirectorNodeOperationRequest {
  nodeId: string;
  operation: DirectorBlenderOperation;
  frame?: number;
  sceneSource?: DirectorSceneSource;
}

export interface DirectorSceneIdentity {
  sceneId: string;
  revision: number;
  sha256: string;
}

export type DirectorOperationState =
  | 'preparing'
  | 'running'
  | 'collecting'
  | 'cancelling'
  | 'succeeded'
  | 'cancelled'
  | 'stale'
  | 'failed';

/** 白名单公开快照；不能添加原生路径、媒体 URL、控制器或完整 Manifest。 */
export interface DirectorOperationSnapshot {
  operationId: string;
  projectId: string;
  nodeId: string;
  instanceId: string;
  operation: DirectorBlenderOperation;
  sceneSource: DirectorSceneSource;
  state: DirectorOperationState;
  jobId?: string;
  scene?: DirectorSceneIdentity;
  progress?: NonNullable<DirectorBlenderJobStatus['progress']>;
  result?: {
    nodeIds: string[];
    manifestRevision: number;
    hasFrame: boolean;
    hasVideo: boolean;
    hasBlend: boolean;
    frame?: number;
    timeline?: { startFrame: number; endFrame: number; fps: number };
  };
  error?: { code: string; message: string };
  createdAt: number;
  updatedAt: number;
}

export interface DirectorNodeState {
  nodeId: string;
  projectId: string;
  instanceId: string;
  runtimeKind: DirectorRuntimeKind | null;
  availability: 'ready' | 'setup-required' | 'unavailable';
  scene?: DirectorSceneIdentity;
  manifestRevision?: number;
  activeOperation?: DirectorOperationSnapshot;
  captureCount: number;
  hasVideo: boolean;
  /** 下次操作的默认场景来源；MCP 可通过 sceneSource 明确覆盖。 */
  renderContract: DirectorSceneSource;
  supportsSavedScene?: boolean;
}
