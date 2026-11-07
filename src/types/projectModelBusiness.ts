/** P3 隔离样本业务合同；不是正式模型激活或原生授权租约。 */
import type {
  CanvasDocument, CanvasPreview, EpisodeContent, EpisodeRecord, EpisodeSettingsPolicy,
  ProjectContent, ProjectRecord,
} from './project';

export const PROJECT_MODEL_BUSINESS_FIXTURE_KEY = 'project-model-business-fixture' as const;
export interface ProjectModelFixtureBusinessSession {
  id: typeof PROJECT_MODEL_BUSINESS_FIXTURE_KEY;
  operationId: string;
  generation: number;
  sessionId: string;
  sourceJournalSequence: number;
  sourceDigest: string;
  targetManifestDigest: string;
  revision: number;
  dirty: boolean;
}
export interface ProjectModelBusinessSelection {
  activeProjectId: string;
  activeCanvasId: string | null;
  activeEpisodeId: string | null;
  contextKind: 'project' | 'canvas';
  projectEpoch: number;
  canvasEpoch?: number;
  canvasRevision?: number;
  generation: number;
}
export interface ProjectModelProjectVersion {
  project: ProjectRecord;
  sessionRevision: number;
}
export interface ProjectModelProjectMutation {
  projectId: string;
  expectedProjectEpoch: number;
  now?: number;
  signal?: AbortSignal;
}
export interface ProjectModelCanvasSave extends ProjectModelProjectMutation {
  canvasId: string;
  expectedCanvasEpoch: number;
  expectedCanvasRevision: number;
  document: Pick<CanvasDocument, 'nodes' | 'edges' | 'groups'>;
  preview?: Pick<CanvasPreview, 'snapshot'> | null;
}
export interface ProjectModelEpisodeSave extends ProjectModelProjectMutation {
  episodeId: string;
  expectedEpisodeRevision: number;
  expectedContentRevision: number;
  patch: Partial<Pick<EpisodeContent, 'outline' | 'script' | 'scriptFile' | 'creative' | 'assetRoster'>>;
}
export type ProjectModelContentSave = ProjectModelProjectMutation & (
  | { domain: 'source'; expectedRevision: number; value: ProjectContent['originalWork'] }
  | { domain: 'script'; expectedRevision: number; value: ProjectContent['script'] }
  | { domain: 'storyGraph'; expectedRevision: number; value: ProjectContent['storyGraph'] }
  | { domain: 'assets'; expectedRevision: number; value: ProjectContent['dramaAssets'] }
  | { domain: 'standaloneCreative'; expectedRevision: number; value: Omit<NonNullable<ProjectContent['standaloneCreative']>, 'revision' | 'storageRootRef'> | undefined }
);
export interface ProjectModelCreateEpisode extends ProjectModelProjectMutation {
  episodeId: string;
  canvasId: string;
  name: string;
  displayNo?: number;
}
export interface ProjectModelConvertStandalone extends ProjectModelProjectMutation {
  episodeId: string;
  name: string;
  displayNo?: number;
}
export interface ProjectModelEpisodeVersion {
  id: string;
  revision: number;
}
export interface ProjectModelEpisodeOrder extends ProjectModelProjectMutation {
  expectedEpisodes: ProjectModelEpisodeVersion[];
  orderedEpisodeIds: string[];
}
export interface ProjectModelDeleteEpisode extends ProjectModelProjectMutation {
  episodeId: string;
  expectedEpisodeRevision: number;
  expectedCanvasEpoch: number;
  expectedCanvasRevision: number;
}
export interface ProjectModelDeleteProject extends ProjectModelProjectMutation {
  /** 删除前读取的整个fixture版本，避免漏掉任何较晚的创作写入。 */
  expectedSessionRevision: number;
}
export interface ProjectModelBusinessTombstone {
  id: string;
  kind: 'project' | 'episode' | 'canvas';
  projectId: string;
  targetId: string;
  generation: number;
  operationId: string;
  previousEpoch: number;
  epoch: number;
  deletedAt: number;
}
export type ProjectModelEpisodeSettingsUpdate = ProjectModelProjectMutation & {
  episodeId: string;
  expectedEpisodeRevision: number;
  policy: EpisodeSettingsPolicy;
};
export interface ProjectModelBusinessReadOptions { signal?: AbortSignal }
export type ProjectModelStored<T> = T & { generation: number; operationId: string };
export type ProjectModelStoredEpisode = ProjectModelStored<EpisodeRecord>;
