/** 原文写作会话只存在于主窗口内存；快照摘要不得携带正文或本地路径。 */
export interface OriginalWritingSummary {
  loaded: boolean;
  loading: boolean;
  dirty: boolean;
  saving: boolean;
  generating: boolean;
  documentId?: string;
  revision: number;
  acceptedSequence: number;
  fileName?: string;
  characterCount: number;
  chapterCount: number;
  error?: string;
  hasCandidate: boolean;
}

export interface OriginalWritingHandoff {
  documentId: string;
  sequence: number;
  content: string;
}

export interface OriginalWritingCandidate {
  id: string;
  text: string;
  mode: 'continue' | 'polish';
  start: number;
  end: number;
  /** 生成时的正文版本；编辑后候选保留，但应用前必须重新校验。 */
  revision: number;
}

/** 仅通过当前编辑器的受限 RPC 返回，不进入 Store、历史或窗口摘要。 */
export interface OriginalWritingDocument {
  documentId: string;
  revision: number;
  acceptedSequence: number;
  fileName: string;
  content: string;
  candidate?: OriginalWritingCandidate;
}

export type OriginalWritingAction =
  | { type: 'original_open' }
  | { type: 'original_edit'; handoff: OriginalWritingHandoff }
  | { type: 'original_save' }
  | { type: 'original_reload'; discard?: boolean }
  | { type: 'original_generate'; mode: 'continue' | 'polish'; start: number; end: number; instruction: string; expectedSequence: number }
  | { type: 'original_apply'; candidateId: string }
  | { type: 'original_discard_candidate' }
  | { type: 'original_cancel' };
