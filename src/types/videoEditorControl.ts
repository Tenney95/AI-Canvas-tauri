/** MCP 剪辑合同不接收路径、URL 或可执行内容。 */
import type { VideoEditorClip, VideoEditorProjectRecord, VideoEditorTrack } from './videoEditor';

export type VideoEditorClipInput = Pick<VideoEditorClip,
  'id' | 'kind' | 'nodeId' | 'timelineStart' | 'sourceIn' | 'sourceOut'
  | 'transform' | 'transitionIn' | 'volume' | 'volumePoints' | 'textStyle'>;
export type VideoEditorTrackInput = Omit<VideoEditorTrack, 'clips'> & { clips: VideoEditorClipInput[] };
export interface VideoEditorCreateInput {
  nodeIds?: string[];
  shotlistNodeId?: string;
  includeDialogueCaptions?: boolean;
  name?: string;
}
export interface VideoEditorUpdateInput {
  editorId: string;
  expectedVersion: string;
  name?: string;
  tracks?: VideoEditorTrackInput[];
  output?: NonNullable<VideoEditorProjectRecord['output']>;
}
export interface VideoEditorControlContext {
  projectId: string;
  signal: AbortSignal;
  baseRevision?: number;
}
export interface VideoEditorExportInput {
  editorId: string;
  expectedVersion: string;
  /** 同一工程下相同请求键不重复渲染或写盘。 */
  requestKey: string;
}
export interface VideoEditorExportStatus {
  jobId: string;
  editorId: string;
  version: string;
  status: 'queued' | 'running' | 'saving' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;
  stage: string;
  createdAt: number;
  finishedAt?: number;
  nodeId?: string;
  fileName?: string;
  duration?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  audioMode?: string;
  error?: string;
}
/** 允许回传 MCP 的固定业务校验错误，不包含底层路径或地址。 */
export class VideoEditorControlError extends Error {
  constructor(message: string) { super(message); this.name = 'VideoEditorControlError'; }
}
