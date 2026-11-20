/** RunningHub 标准模型首次取图与旧任务续查共享的状态和产物合同。 */
import type { RunningHubMediaKind, RunningHubOutput } from '../../../types/runninghub';

export const RUNNINGHUB_AUDIO_OUTPUT_TYPE = /^(audio|mp3|wav|flac|ogg|m4a|aac|pcm|opus)$/;

/** 标准模型的首次查询和续查使用同一状态映射，服务商确认取消时按失败终态处理。 */
export function readRunningHubModelStatus(value: unknown): string {
  const status = typeof value === 'string' ? value.toUpperCase() : '';
  return status === 'CANCELED' || status === 'CANCELLED' ? 'FAILED' : status;
}

/** 按原顺序筛选请求类型的标准模型产物，缺少可用产物时保留原任务供处理。 */
export function parseRunningHubModelOutputs(results: unknown, kind: RunningHubMediaKind): RunningHubOutput[] {
  if (!Array.isArray(results)) throw new Error('RunningHub 已完成但未返回产物数组');
  const outputs: RunningHubOutput[] = [];
  for (const value of results as unknown[]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const result = value as Record<string, unknown>;
    if (typeof result.url !== 'string') continue;
    let url: URL;
    try { url = new URL(result.url); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    const format = String(result.outputType || url.pathname.split('.').pop() || '').toLowerCase().replace(/^\./, '');
    const resultKind = /^(image|png|jpg|jpeg|webp|gif|bmp|tiff|avif)$/.test(format) ? 'image'
      : /^(video|mp4|webm|mov|mkv|avi)$/.test(format) ? 'video'
        : RUNNINGHUB_AUDIO_OUTPUT_TYPE.test(format) ? 'audio' : undefined;
    if ((resultKind && resultKind !== kind) || /^(json|txt|obj|glb|gltf|zip)$/.test(format)) continue;
    outputs.push({ url: result.url, kind });
  }
  if (!outputs.length) throw new Error('RunningHub 未返回所选类型的媒体产物，任务已保留');
  return outputs;
}
