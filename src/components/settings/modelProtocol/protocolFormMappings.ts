import type { GeneralModelCategory, ProviderModelSelection } from '../../../types';
import type {
  ModelExecutionProtocol,
  NormalizedModelExecutionProtocol,
  ModelProtocolAuthType,
  ModelProtocolPollTemplate,
  ModelProtocolPollRetryConfig,
  ModelProtocolPollResponseConfig,
  ModelProtocolRequestTemplate,
  ModelProtocolResponseType,
  ModelProtocolResultConfig,
  ProtocolJsonValue,
} from '../../../types/aiTypes';
import {
  getDefaultModelProtocolPollRetryConfig,
  parseModelExecutionProtocol,
  validateModelExecutionProtocol,
} from '../../../services/ai/modelProtocol';
import { getCategoryProtocolVariables } from '../../../services/ai/modelProtocolVariables';
import type { ProtocolChoice } from '../modelProtocolTestRun';
import { assertModelProtocolResultMapping } from '../../../services/ai/modelCapabilityValidation';

export const PRESET_LABELS: Record<ProtocolChoice, string> = {
  legacy: '自动兼容（旧方式）',
  'openai-chat': 'OpenAI Chat',
  'openai-responses': 'OpenAI Responses',
  'anthropic-chat': 'Anthropic Messages',
  'gemini-chat': 'Google Gemini generateContent',
  'openai-image': 'OpenAI 同步图片（旧预设）',
  'openai-gpt-image': 'OpenAI GPT-Image 官方 Images',
  'gpt-image-gateway-json': 'GPT-Image 中转站 JSON（images 参考图）',
  'google-image-native': 'Google Gemini 原生图片（文生图）',
  'xai-image-native': 'xAI Images 原生图片（文生图）',
  'agnes-video': 'Agnes 异步视频',
  custom: '高级自定义 JSON',
  plugin: '插件协议预设',
};

// 可用变量列表由 modelProtocolVariables 总表派生，避免与运行时实际提供的变量脱节
export const CATEGORY_VARIABLES: Record<GeneralModelCategory, string[]> = {
  text: getCategoryProtocolVariables('text'),
  image: getCategoryProtocolVariables('image'),
  video: getCategoryProtocolVariables('video'),
  audio: getCategoryProtocolVariables('audio'),
};

export const MULTIPART_FILE_FIELDS: Record<'image' | 'video', Record<string, string>> = {
  image: {
    image: 'imageUrls.0',
    'image[]': 'imageUrls',
    file: 'imageUrls.0',
    reference_image: 'imageUrls.0',
  },
  video: {
    first_frame: 'firstImage',
    last_frame: 'lastImage',
    image: 'referenceImageUrls.0',
    images: 'referenceImageUrls',
    video: 'referenceVideoUrls.0',
    videos: 'referenceVideoUrls',
    audio: 'referenceAudioUrls.0',
    audios: 'referenceAudioUrls',
  },
};

export function getAvailableChoices(category: GeneralModelCategory, current: ProtocolChoice): ProtocolChoice[] {
  if (category === 'text') return ['legacy', 'openai-chat', 'openai-responses', 'anthropic-chat', 'gemini-chat', 'custom'];
  if (category === 'image') return ['legacy', 'gpt-image-gateway-json', 'openai-gpt-image',
    'google-image-native', 'xai-image-native', ...(current === 'openai-image' ? ['openai-image' as const] : []), 'custom'];
  if (category === 'video') return ['legacy', 'agnes-video', 'custom'];
  return ['legacy', 'custom'];
}

export function parseDraft(value: string): { protocol?: NormalizedModelExecutionProtocol; error?: string } {
  try {
    const parsed: unknown = JSON.parse(value);
    const errors = validateModelExecutionProtocol(parsed);
    if (errors.length > 0) return { error: errors[0] };
    return { protocol: parseModelExecutionProtocol(parsed) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : '协议 JSON 无效' };
  }
}

export function protocolDraftErrors(protocol: NormalizedModelExecutionProtocol, category: GeneralModelCategory): string[] {
  const errors = validateModelExecutionProtocol(protocol);
  if (!errors.length) {
    try { assertModelProtocolResultMapping(category, protocol); }
    catch (error) { errors.push(error instanceof Error ? error.message : '结果映射无效'); }
  }
  return errors;
}

export function serializeJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

export function isJsonObject(value: ProtocolJsonValue | undefined): value is Record<string, ProtocolJsonValue> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function createDefaultPoll(category: GeneralModelCategory): ModelProtocolPollTemplate {
  return {
    method: 'GET',
    // 视频接口没有统一查询端点；保持无效直到用户按文档填写，避免重新制造
    // /tasks/{id} 这类看似可执行、实则 404 的猜测协议。
    path: category === 'video' ? '' : '/tasks/{{submit.task_id}}',
    response: {
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed', 'error'],
      result: category === 'text' ? { textPath: 'result.text' } : { urlPath: 'url' },
      errorPath: 'error.message',
      progressPath: 'progress',
    },
    intervalMs: 3000,
  };
}

export function createProtocolFormActions({
  model, allowFormTransform, updateProtocol, setFormRevision,
}: {
  model: ProviderModelSelection;
  allowFormTransform: () => boolean;
  updateProtocol: (mutate: (draft: NormalizedModelExecutionProtocol) => void) => void;
  setFormRevision: (update: (current: number) => number) => void;
}) {
  const changeMode = (mode: ModelExecutionProtocol['mode']) => {
    if (!allowFormTransform()) return;
    updateProtocol((draft) => {
      draft.mode = mode;
      if (mode === 'sync') {
        delete draft.poll;
        draft.response = {
          type: 'json',
          result: model.category === 'text'
            ? { textPath: 'choices.0.message.content' }
            : { urlPath: 'data.*.url' },
          errorPath: draft.response.errorPath,
        };
      } else {
        draft.response = {
          type: 'json',
          taskIdPath: draft.response.taskIdPath ?? 'task_id',
          errorPath: draft.response.errorPath,
        };
        draft.poll ??= createDefaultPoll(model.category);
      }
    });
  };

  const changeAuthType = (type: ModelProtocolAuthType) => {
    updateProtocol((draft) => {
      if (type === 'header') draft.auth = { type, name: 'X-API-Key' };
      else if (type === 'query') draft.auth = { type, name: 'api_key' };
      else draft.auth = { type };
    });
  };

  const changeResponseType = (responseType: ModelProtocolResponseType) => {
    updateProtocol((draft) => {
      draft.response.type = responseType;
      if (responseType === 'json') {
        const result = draft.response.result ?? {};
        if (!result.urlPath && !result.textPath && !result.base64Path) {
          if (model.category === 'text') result.textPath = 'choices.0.message.content';
          else result.urlPath = 'data.*.url';
        }
        draft.response.result = result;
        return;
      }
      if (responseType === 'text') delete draft.response.result;
      else draft.response.result = draft.response.result?.mimeType
        ? { mimeType: draft.response.result.mimeType }
        : {};
    });
  };

  const insertSizeMapping = (mapping: string) => {
    if (!mapping) return;
    if (!allowFormTransform()) return;
    updateProtocol((draft) => {
      const body = isJsonObject(draft.submit.body) ? draft.submit.body : {};
      if (mapping === 'size') body.size = '{{size}}';
      if (mapping === 'dimensions') {
        body.width = '{{width}}';
        body.height = '{{height}}';
      }
      if (mapping === 'image-semantic') {
        body.resolution = '{{imageSize}}';
        body.aspect_ratio = '{{aspectRatio}}';
      }
      if (mapping === 'video-standard') {
        body.resolution = '{{videoResolution}}';
        body.num_frames = '{{videoFrames}}';
        body.frame_rate = '{{videoFps}}';
      }
      if (mapping === 'seedance') {
        body.resolution = '{{seedanceResolution}}';
        body.ratio = '{{seedanceRatio}}';
        body.duration = '{{seedanceDuration}}';
      }
      if (mapping === 'seedance-openai') {
        body.resolution = '{{seedanceResolution}}';
        body.aspect_ratio = '{{aspectRatio}}';
        body.duration = '{{duration}}';
        body.generate_audio = '{{generateAudio}}';
      }
      draft.submit.body = body;
    });
    setFormRevision((current) => current + 1);
  };

  const insertMultipartFile = (fieldName: string, variable = 'imageUrls.0') => {
    if (!fieldName) return;
    if (!allowFormTransform()) return;
    updateProtocol((draft) => {
      const body = isJsonObject(draft.submit.body) ? draft.submit.body : {};
      body[fieldName] = {
        $file: `{{${variable}}}`,
        ...(variable.startsWith('imageUrls') ? { filename: 'reference.png' } : {}),
      };
      draft.submit.bodyEncoding = 'multipart';
      draft.submit.body = body;
    });
    setFormRevision((current) => current + 1);
  };

  const insertJsonReferenceArray = (fieldName: string) => {
    if (!fieldName) return;
    if (!allowFormTransform()) return;
    updateProtocol((draft) => {
      const body = isJsonObject(draft.submit.body) ? draft.submit.body : {};
      body[fieldName] = '{{imageUrls}}';
      draft.submit.bodyEncoding = 'json';
      draft.submit.body = body;
    });
    setFormRevision((current) => current + 1);
  };

  const insertVideoReferenceField = (mapping: string) => {
    if (!allowFormTransform()) return;
    const mappings: Record<string, string> = {
      image_urls: 'imageUrls',
      first_image: 'firstImage',
      last_image: 'lastImage',
      reference_image_urls: 'referenceImageUrls',
      video_urls: 'videoUrls',
      reference_video_url: 'referenceVideoUrl',
      reference_video_urls: 'referenceVideoUrls',
      audio_urls: 'audioUrls',
      audio_url: 'audioUrl',
      reference_audio_urls: 'referenceAudioUrls',
    };
    const variable = mappings[mapping];
    if (!variable) return;
    updateProtocol((draft) => {
      const body = isJsonObject(draft.submit.body) ? draft.submit.body : {};
      body[mapping] = `{{${variable}}}`;
      draft.submit.bodyEncoding = 'json';
      draft.submit.body = body;
    });
    setFormRevision((current) => current + 1);
  };

  const updateSubmit = (patch: Partial<ModelProtocolRequestTemplate>) => {
    updateProtocol((draft) => {
      draft.submit = { ...draft.submit, ...patch };
    });
  };

  const updatePoll = (patch: Partial<ModelProtocolPollTemplate>) => {
    updateProtocol((draft) => {
      draft.poll = { ...(draft.poll ?? createDefaultPoll(model.category)), ...patch };
    });
  };

  const updateResponse = (patch: Partial<NormalizedModelExecutionProtocol['response']>) => {
    updateProtocol((draft) => {
      draft.response = { ...draft.response, ...patch };
    });
  };

  const updateResponseResult = (patch: Partial<ModelProtocolResultConfig>) => {
    updateProtocol((draft) => {
      draft.response.result = { ...(draft.response.result ?? {}), ...patch };
    });
  };

  const updatePollResponse = (patch: Partial<ModelProtocolPollResponseConfig>) => {
    updateProtocol((draft) => {
      const currentPoll = draft.poll ?? createDefaultPoll(model.category);
      currentPoll.response = { ...currentPoll.response, ...patch };
      draft.poll = currentPoll;
    });
  };

  const updatePollResult = (patch: Partial<ModelProtocolResultConfig>) => {
    updateProtocol((draft) => {
      const currentPoll = draft.poll ?? createDefaultPoll(model.category);
      currentPoll.response.result = { ...currentPoll.response.result, ...patch };
      draft.poll = currentPoll;
    });
  };

  const updatePollRetry = (patch: Partial<ModelProtocolPollRetryConfig>) => {
    updateProtocol((draft) => {
      const currentPoll = draft.poll ?? createDefaultPoll(model.category);
      currentPoll.retry = {
        ...getDefaultModelProtocolPollRetryConfig(),
        ...currentPoll.retry,
        ...patch,
      };
      draft.poll = currentPoll;
    });
  };

  return {
    changeMode, changeAuthType, changeResponseType, insertSizeMapping, insertMultipartFile,
    insertJsonReferenceArray, insertVideoReferenceField, updateSubmit, updatePoll, updateResponse,
    updateResponseResult, updatePollResponse, updatePollResult, updatePollRetry,
  };
}
