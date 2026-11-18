/**
 * modelProtocolTestRun — 构造模型协议试运行场景并校验真实请求变量。
 */
import type { ProviderModelSelection } from '../../types';
import type { MediaReference, ModelProtocolPresetId, NormalizedModelExecutionProtocol, ProtocolJsonValue } from '../../types/aiTypes';
import { parseModelExecutionProtocol, type ModelProtocolVariables } from '../../services/ai/modelProtocol';
import type { PluginModelProtocolReference } from '../../types/plugin';
import { parsePluginProtocolReference } from '../../services/plugins/pluginProtocolPresetService';
import type { ChatApiMessage } from '../../services/ai/chatApiProtocol';

export type ProtocolChoice = ModelProtocolPresetId | 'legacy';

export function pluginProtocolChoice(reference: PluginModelProtocolReference): string {
  const ref = parsePluginProtocolReference({ pluginId: reference.pluginId, presetId: reference.presetId });
  return `plugin:${ref.pluginId}/${ref.presetId}`;
}

export function parsePluginProtocolChoice(value: string): PluginModelProtocolReference | undefined {
  if (!value.startsWith('plugin:')) return undefined;
  const [pluginId, presetId, extra] = value.slice(7).split('/');
  if (extra !== undefined) throw new Error('插件预设选择无效');
  return parsePluginProtocolReference({ pluginId, presetId });
}

/** 真实试跑保留输入消息和多图；不能再只提取 prompt 导致参考素材丢失。 */
export function nativeProtocolTestMessages(variables: ModelProtocolVariables): ChatApiMessage[] {
  if (variables.messages === undefined) return [{ role: 'user', content: typeof variables.prompt === 'string' ? variables.prompt : '介绍这个模型' }];
  if (!Array.isArray(variables.messages) || !variables.messages.length) throw new Error('试跑 messages 必须是非空消息数组');
  for (const message of variables.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || !['system', 'user', 'assistant', 'tool'].includes(String(message.role))
      || !(typeof message.content === 'string' || Array.isArray(message.content))) throw new Error('试跑消息格式无效');
    if (Array.isArray(message.content)) for (const part of message.content) {
      if (!part || typeof part !== 'object' || Array.isArray(part)
        || !(part.type === 'text' && typeof part.text === 'string'
          || part.type === 'image_url' && part.image_url && typeof part.image_url === 'object' && !Array.isArray(part.image_url)
            && typeof part.image_url.url === 'string')) throw new Error('试跑消息内容仅支持 text 和 image_url');
    }
  }
  return variables.messages as unknown as ChatApiMessage[];
}

export type VideoTestScenario = 'text' | 'keyframe' | 'reference';
export interface VideoTestReferences {
  firstImage: string;
  lastImage: string;
  images: string;
  videos: string;
  audios: string;
}

export function defaultVideoTestScenario(model: ProviderModelSelection): VideoTestScenario {
  const capability = model.videoCapability;
  if (capability?.requiresReference || capability?.operations?.length && !capability.operations.includes('text-to-video')) {
    return capability?.operations?.includes('video-to-video') ? 'reference' : 'keyframe';
  }
  return 'text';
}

/** 真实试跑只接受用户提供的公网素材；本地文件应通过节点的素材准备链路使用。 */
function realMediaUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch {
    throw new Error('请填写真实的 HTTP(S) 素材地址，不能使用示例地址或本地路径');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || /(^|\.)(example|invalid|test|localhost)$/.test(url.hostname) || url.hostname === 'example.com'
    || url.hostname.endsWith('.example.com')) {
    throw new Error('请填写真实的 HTTP(S) 素材地址，不能使用示例地址或本地路径');
  }
  return url.href;
}

export function videoTestReferences(scenario: VideoTestScenario, input: VideoTestReferences): MediaReference[] {
  const references: MediaReference[] = [];
  const append = (text: string, kind: MediaReference['kind'], role: MediaReference['role']) => {
    for (const value of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      references.push({ kind, role, origin: 'connection', url: realMediaUrl(value) });
    }
  };
  if (scenario === 'keyframe') {
    if (!input.firstImage.trim()) throw new Error('首尾帧试跑需要填写首帧图片地址');
    append(input.firstImage, 'image', 'first_frame');
    append(input.lastImage, 'image', 'last_frame');
  } else if (scenario === 'reference') {
    append(input.images, 'image', 'reference');
    append(input.videos, 'video', 'reference');
    append(input.audios, 'audio', 'reference_audio');
    if (!references.length) throw new Error('多参考试跑需要至少一份真实参考素材');
  }
  return references;
}

/** 预览数据不能直接带入付费请求，尤其不能把占位链接误当成真实素材。 */
export function assertRealProtocolTestVariables(value: ProtocolJsonValue): void {
  if (typeof value === 'string') {
    if (/https?:\/\/[^\s"<>]*\.(?:example|invalid|test)(?:[/:?#]|$)/i.test(value)
      || value.includes('data:image/png;base64,iVBORw0KGgo=')) {
      throw new Error('试跑变量包含示例素材，请换成真实素材后再试跑');
    }
  } else if (Array.isArray(value)) value.forEach(assertRealProtocolTestVariables);
  else if (value && typeof value === 'object') Object.values(value).forEach(assertRealProtocolTestVariables);
}

/** 延迟加载现有视频变量构造器，参数及素材角色与节点共用同一套规则。 */
export async function buildVideoTestVariables(
  model: ProviderModelSelection,
  scenario: VideoTestScenario,
  input: VideoTestReferences,
  overrides: ModelProtocolVariables,
): Promise<ModelProtocolVariables> {
  const references = videoTestReferences(scenario, input);
  for (const key of ['duration', 'seedanceDuration', 'fps', 'videoFps', 'frames', 'videoFrames', 'videoResolution']) {
    if (overrides[key] !== undefined && (typeof overrides[key] !== 'number' || !Number.isFinite(overrides[key]))) {
      throw new Error('试跑的视频数值参数必须是有限数值，请检查时长、帧率、帧数和长边像素');
    }
  }
  const { buildGeneralVideoProtocolVariables } = await import('../../services/ai/generateVideo');
  const stringValue = (...keys: string[]) => keys.map((key) => overrides[key]).find((value): value is string => typeof value === 'string');
  const numberValue = (...keys: string[]) => keys.map((key) => overrides[key]).find((value): value is number => typeof value === 'number');
  const prompt = typeof overrides.prompt === 'string' ? overrides.prompt : '';
  const variables = buildGeneralVideoProtocolVariables(model.id, {
    model: model.id, provider: model.provider, prompt,
    seedanceResolution: stringValue('seedanceResolution', 'resolution'),
    seedanceRatio: stringValue('aspectRatio', 'seedanceRatio'),
    seedanceDuration: numberValue('duration', 'seedanceDuration'),
    videoFps: numberValue('fps', 'videoFps'),
    videoFrames: numberValue('frames', 'videoFrames'),
    videoResolution: numberValue('videoResolution'),
    generateAudio: typeof overrides.generateAudio === 'boolean' ? overrides.generateAudio : undefined,
  }, {
    prompt, references,
    imageUrls: references.filter((reference) => reference.kind === 'image').map((reference) => reference.url),
    videoUrls: references.filter((reference) => reference.kind === 'video').map((reference) => reference.url),
    audioUrls: references.filter((reference) => reference.kind === 'audio').map((reference) => reference.url),
    operation: references.some((reference) => reference.kind === 'video') ? 'video-to-video'
      : references.length ? 'image-to-video' : 'text-to-video',
  }, model.videoCapability);
  // 素材与衍生参数只由当前场景及共享构造器决定，不能被 JSON 中另一种模式的旧变量覆盖。
  return { ...overrides, ...variables };
}

/**
 * 试跑的前置条件；返回 null 表示可以真发请求。
 * 「自动兼容」不走声明式协议，运行时直接调标准端点，没有协议可跑。
 */
export function describeProtocolTestRunBlocker(
  preset: ProtocolChoice,
  apiKey: string,
  baseUrl: string,
  invalidDraft = false,
): 'legacy-preset' | 'missing-base-url' | 'missing-api-key' | 'invalid-draft' | null {
  if (preset === 'legacy') return 'legacy-preset';
  if (!baseUrl.trim()) return 'missing-base-url';
  if (!apiKey.trim()) return 'missing-api-key';
  if (invalidDraft) return 'invalid-draft';
  return null;
}

/** 试跑使用当前草稿；子表单无效时不能退回上一次有效协议。 */
export function resolveProtocolTestRunDraft(
  preset: ProtocolChoice,
  protocol: NormalizedModelExecutionProtocol,
  jsonDraft: string,
  invalidFormFields = false,
): NormalizedModelExecutionProtocol {
  if (preset === 'plugin') throw new Error('插件预设试跑必须核验原生活动适配器');
  if (invalidFormFields) throw new Error('请修正表单中的 JSON 错误');
  return parseModelExecutionProtocol(preset === 'custom' ? JSON.parse(jsonDraft) : protocol);
}
