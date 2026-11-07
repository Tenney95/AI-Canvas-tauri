import type { CanvasContext, ProjectExpectedContext } from './project';

/** 窗口并发前提；不是原生调用方身份或文件授权。画布 A 与工作台分集 B 可同时存在。 */
export interface ProjectWindowContext {
  schemaVersion: 2;
  target: ProjectExpectedContext;
  canvas: CanvasContext | null;
}

export interface ProjectWindowFrame {
  schemaVersion: 2;
  sessionId: string;
  revision: number;
  context: ProjectWindowContext;
  conversationId?: string | null;
}
