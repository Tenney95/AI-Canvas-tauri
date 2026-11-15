/** 大纲资料目录的运行时列表与编辑摘要；不携带正文或本地路径。 */
export type OutlineDocumentKind = 'text' | 'pdf' | 'presentation' | 'word' | 'legacy-word';

export interface OutlineDocumentFile {
  id: string;
  fileName: string;
  kind: OutlineDocumentKind;
  size: number;
  modifiedAt?: number;
}

export interface OutlineDocumentSummary {
  files: OutlineDocumentFile[];
  /** 资料列表已成功扫描（包括目录不存在时的空列表），与是否打开正文无关。 */
  loaded: boolean;
  selected: boolean;
  busy: boolean;
  dirty: boolean;
  revision: number;
  fileId?: string;
  documentId?: string;
  acceptedSequence: number;
  fileName?: string;
  error?: string;
}

export interface OutlineDocumentHandoff {
  documentId: string;
  sequence: number;
  content: string;
}

/** 正文和二进制仅通过当前编辑器的显式 RPC 传递，不进入窗口摘要与持久化。 */
export type OutlineOpenedDocument =
  | { kind: 'text'; documentId: string; fileName: string; revision: number; acceptedSequence: number; content: string }
  | { kind: 'pdf' | 'presentation' | 'word' | 'legacy-word'; documentId: string; fileName: string; base64: string };

export type OutlineDocumentAction =
  | { type: 'outline_list' }
  | { type: 'outline_select_builtin' }
  | { type: 'outline_create'; name: string; extension: 'md' | 'txt' }
  | { type: 'outline_import' }
  | { type: 'outline_open'; id: string }
  | { type: 'outline_edit'; handoff: OutlineDocumentHandoff }
  | { type: 'outline_save' }
  | { type: 'outline_reload'; discard?: boolean };
