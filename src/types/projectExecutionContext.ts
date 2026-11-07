/** 执行前置条件与旧身份的只读适配；不迁移任务、回执或授权。 */
import type { ProjectExpectedContext, ProjectExecutionTarget } from './project';

export interface ProjectExecutionContextState {
  currentProjectId: string | null;
  projects?: ReadonlyArray<{ id: string; parentId?: string; exchangeEpoch?: number; name?: string; episodeNo?: number; series?: unknown }>;
  getCurrentRevision: () => number;
  projectLoadStatus?: string;
  switchingProjectName?: string | null;
  isCreatingProject?: boolean;
  isReturningToStartPage?: boolean;
  /** 仅受信隔离宿主可供应；null表示暂不可用，不得降回旧模型。普通AppState未激活该数据源。 */
  projectExecutionContext?: ProjectExpectedContext | null;
}
export interface ProjectExecutionBinding {
  schemaVersion: 2;
  expectedContext: ProjectExpectedContext;
  target: ProjectExecutionTarget | { kind: 'global' };
}
