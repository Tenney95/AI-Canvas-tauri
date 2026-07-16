/**
 * 项目记忆类型（P3-D2）。
 *
 * 记忆由 Agent 提出候选、用户确认后写入，按项目隔离。
 * 只保存简短事实，不保存文件全文、网页全文、密钥或临时路径。
 */

export type ProjectMemoryKind = 'preference' | 'fact' | 'constraint' | 'decision';

export const PROJECT_MEMORY_KIND_LABELS: Record<ProjectMemoryKind, string> = {
  preference: '偏好',
  fact: '事实',
  constraint: '约束',
  decision: '决定',
};

/** 上下文注入排序时的类别优先级（数值越小越靠前）。 */
export const PROJECT_MEMORY_KIND_PRIORITY: Record<ProjectMemoryKind, number> = {
  constraint: 0,
  decision: 1,
  preference: 2,
  fact: 3,
};

/** 单条记忆正文长度上限，防止把文件/网页全文写入长期记忆。 */
export const PROJECT_MEMORY_CONTENT_LIMIT = 500;

/** 每个项目最多保存的记忆条数。 */
export const PROJECT_MEMORY_MAX_PER_PROJECT = 100;

export interface ProjectMemorySource {
  conversationId: string;
  /** 触发候选的用户消息 ID */
  messageId?: string;
  taskId?: string;
  /** 来源对话被删除后为 true：记忆保留，但来源不可回溯。 */
  unavailable?: boolean;
}

export interface ProjectMemory {
  id: string;
  projectId: string;
  kind: ProjectMemoryKind;
  content: string;
  /** 是否参与上下文注入；用户可禁用而不删除。 */
  enabled: boolean;
  source: ProjectMemorySource;
  createdAt: number;
  updatedAt: number;
}
