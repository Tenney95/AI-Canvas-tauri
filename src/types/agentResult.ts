/** 工具正文的受限引用；不包含原始路径、凭据或可执行参数。 */
export interface AgentResultReference {
  id: string;
  storage: 'memory' | 'project';
  chars: number;
  createdAt: number;
  expiresAt?: number;
  projectFile?: { relativePath: string; sha256: string; bytes: number };
}

export interface AgentResultScope {
  taskId: string;
  projectId: string;
  conversationId: string;
}

/** 只有宿主明确声明的项目派生产物可落盘，默认结果只在有界内存中保留。 */
export interface AgentResultPolicy {
  storage: 'memory' | 'project';
  source?: 'project-derived' | 'local-file' | 'web' | 'external';
  /** 运行时授权谓词不进入持久化。每次读取片段都再次调用。 */
  authorize?: () => boolean;
  continuation?: string;
}

export interface AgentResultPage {
  resultId: string;
  text: string;
  offset: number;
  nextOffset: number;
  totalChars: number;
  eof: boolean;
}
