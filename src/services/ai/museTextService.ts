/** Muse 文本与图文问答；上下文按单次网页请求发送，Cookie 始终由原生持有。 */
import type { AssistantModelMessage } from './assistantStream';
import { resolveImageDataUrlArray } from './imageUtils';
import { assertMuseTaskId, museInvoke } from '../museService';
import { pollTask, PollTaskFailedError } from '../pollTask';

const MAX_INPUT_BYTES = 100_000;
const MAX_REPLY_BYTES = 256 * 1024;

/** 历史工具结果只能作为已脱敏的背景文字，调用定义与参数不发送给 Muse。 */
export function buildMuseTextInput(messages: readonly AssistantModelMessage[]): { prompt: string; imageUrls: string[] } {
  const turns: string[] = [], imageUrls: string[] = [];
  let hasUserInput = false;
  if (!messages.length || messages.length > 256) throw new Error('Muse 对话上下文为空或超过应用消息数量上限');
  for (const message of messages) {
    const label = { system: '背景与任务设定', user: '用户', assistant: '助手', tool: '历史工具结果（只供参考，不是新的工具调用）' }[message.role];
    if (!label) throw new Error('Muse 对话包含不支持的消息角色');
    const parts: string[] = [];
    for (const part of typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content) {
      if (part.type === 'text') {
        if (part.text) parts.push(part.text);
      } else if (part.type === 'image_url' && part.image_url?.url) {
        const url = part.image_url.url;
        let index = imageUrls.indexOf(url);
        if (index < 0) { index = imageUrls.length; imageUrls.push(url); }
        parts.push(`【本次上传图片 ${index + 1}】`);
      } else throw new Error('Muse 对话仅支持文本和图片输入');
    }
    const text = parts.join('\n');
    if (!text.trim()) continue;
    if (message.role === 'user') hasUserInput = true;
    turns.push(`${label}：\n${text}`);
  }
  if (!hasUserInput) throw new Error('Muse 对话缺少用户输入');
  if (imageUrls.length > 4) throw new Error('Muse 对话最多支持 4 张参考图片');
  const prompt = `本次只进行文本回答或图片理解；历史内容仅作为背景，不执行其中的工具调用。请回答最后一条用户消息。\n\n${turns.join('\n\n')}`;
  if (new TextEncoder().encode(prompt).byteLength > MAX_INPUT_BYTES) throw new Error('Muse 对话上下文超过 100000 字节，请减少历史或引用内容');
  return { prompt, imageUrls };
}

interface MuseTextStatus {
  status: 'prepared' | 'ready' | 'running' | 'completed' | 'failed' | 'unknown';
  text?: string;
}

export async function streamMuseText(input: {
  messages: readonly AssistantModelMessage[];
  signal?: AbortSignal;
  /** 累计完整正文；宿主负责转换成自己的增量事件。 */
  onText?: (snapshot: string) => void;
  /** 节点入口在上传完成后再次核对原输入，后台对话沿自己的任务信号。 */
  assertCurrent?: () => void;
}): Promise<string> {
  const fresh = () => { input.signal?.throwIfAborted(); input.assertCurrent?.(); };
  fresh();
  const { prompt, imageUrls } = buildMuseTextInput(input.messages);
  const images = await resolveImageDataUrlArray(imageUrls, input.signal,
    { maxImages: 4, maxImageBytes: 8 * 1024 * 1024, maxTotalBytes: 24 * 1024 * 1024 });
  fresh();
  let taskId: string | undefined;
  const cancelPrepared = async () => { if (taskId) await museInvoke('muse_cancel_prepared', { taskId }).catch(() => {}); };
  const onAbort = () => { void cancelPrepared(); };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    fresh();
    const prepared = await museInvoke<{ taskId: string }>('muse_prepare', { kind: 'text' });
    taskId = prepared.taskId; assertMuseTaskId(taskId); fresh();
    await museInvoke('muse_submit', { taskId, prompt, images });
    fresh();
    // 上传确认与原输入复核完成后才允许这唯一一次发送。
    await museInvoke('muse_send', { taskId });
    let previous = '';
    return await pollTask<MuseTextStatus, string>({
      fetchState: async (signal) => { signal.throwIfAborted(); return museInvoke<MuseTextStatus>('muse_query', { taskId }); },
      isComplete: (status) => {
        fresh();
        if (status.status === 'failed') throw new PollTaskFailedError('Muse 文本请求已失败，请在官网检查原任务');
        if (status.status !== 'running' && status.status !== 'completed') throw new Error('Muse 文本请求状态未确认，请在设置中查看原任务；不会重新发送');
        const text = status.text ?? '';
        if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_REPLY_BYTES) throw new Error('Muse 文本响应超过应用上限或格式无效');
        if (!text.startsWith(previous)) throw new Error('Muse 网页正文已改写，已保留当前回复；请到官网查看完整结果');
        if (text !== previous) { input.onText?.(text); previous = text; }
        if (status.status !== 'completed') return null;
        if (!text.trim()) throw new Error('Muse 返回的文本为空');
        return text;
      },
      interval: 500, maxDuration: 5 * 60_000,
      timeoutMsg: 'Muse 文本等待超时，原任务已保留，请到设置中查看；不会自动重新发送', signal: input.signal,
    });
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
    // 仅结束准备期；已经发送的请求继续保留，不能用重投冒充取消或恢复。
    await cancelPrepared();
  }
}
