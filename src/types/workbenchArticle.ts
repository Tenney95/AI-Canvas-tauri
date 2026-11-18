/** 工作台文章改写只操作内存草稿；正文与候选不进入窗口摘要。 */
export type WorkbenchArticleTarget =
  | { kind: 'outline'; episodeId: string }
  | { kind: 'script'; episodeId: string }
  | { kind: 'original'; documentId: string }
  | { kind: 'outline-document'; documentId: string };

export interface WorkbenchArticleCapture {
  target: WorkbenchArticleTarget;
  projectId: string;
  key: string;
  label: string;
  content: string;
  version: string | number;
}

/** 仅作为当前编辑器显式请求的回执，不进入持久化或普通广播。 */
export interface WorkbenchArticleCandidate {
  id: string;
  text: string;
  targetLabel: string;
}

export interface WorkbenchArticleSummary {
  generating: boolean;
  hasCandidate: boolean;
  targetLabel?: string;
}

export type WorkbenchArticleAction =
  | { type: 'article_generate'; target: WorkbenchArticleTarget; instruction: string }
  | { type: 'article_apply'; candidateId: string }
  | { type: 'article_cancel' }
  | { type: 'article_discard_candidate'; candidateId?: string };
