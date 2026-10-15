/** 本地 ComfyUI 进程的瞬时状态和输出，仅保存在运行期内存。 */
export type ComfyRuntimeStatus = 'idle' | 'starting' | 'running' | 'exited' | 'failed' | 'external';

export interface ComfyRuntimeStartResult {
  runId: string | null;
  status: ComfyRuntimeStatus;
  port: number;
  message: string;
}

export interface ComfyRuntimeLine {
  sequence: number;
  /** Unix 毫秒时间戳。 */
  timestamp: number;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export interface ComfyRuntimeSnapshot extends ComfyRuntimeStartResult {
  exitCode: number | null;
  lines: ComfyRuntimeLine[];
  nextSequence: number;
  truncated: boolean;
}
