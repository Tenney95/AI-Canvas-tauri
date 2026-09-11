/** MCP 客户端上传字节的协议；不接受源路径或输出路径。 */
export interface MediaUploadInput {
  action: 'begin' | 'append' | 'finish' | 'status' | 'cancel';
  uploadId?: string;
  fileName?: string;
  mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
  totalBytes?: number;
  offset?: number;
  data?: string;
  /** append 为当前块 SHA-256；finish 为 sha256-chain-v1 的最终摘要。 */
  checksum?: string;
}

export interface UploadedMediaInput {
  uploadId: string;
  label?: string;
  x?: number;
  y?: number;
}

/** path 与 uploadId 必须恰好提供一个，由导入服务统一校验。 */
export interface MediaResourceInput {
  path?: string;
  uploadId?: string;
  label?: string;
  x?: number;
  y?: number;
}

export interface MediaUploadContext {
  projectId: string;
  conversationId: string;
  baseRevision?: number;
  signal: AbortSignal;
}
