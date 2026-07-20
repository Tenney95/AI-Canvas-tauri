import { Icon } from '@iconify/react';
import { useId, useMemo, useRef, useState } from 'react';
import type { GeneralModelCategory, ProviderModelSelection } from '../../types';
import type {
  ModelExecutionProfile,
  ModelExecutionProtocol,
  NormalizedModelExecutionProtocol,
  ModelProtocolAuthType,
  ModelProtocolBodyEncoding,
  ModelProtocolPollTemplate,
  ModelProtocolPollRetryConfig,
  ModelProtocolPollResponseConfig,
  ModelProtocolPresetId,
  ModelProtocolRequestTemplate,
  ModelProtocolResponseType,
  ModelProtocolResultConfig,
  ProtocolJsonValue,
} from '../../types/aiTypes';
import {
  getDefaultCustomProtocol,
  getDefaultModelProtocolPollRetryConfig,
  getModelProtocolPreset,
  parseModelExecutionProtocol,
  previewModelProtocolRequest,
  previewModelProtocolResponse,
  validateModelExecutionProtocol,
  type ModelProtocolRequestPreview,
  type ModelProtocolResponsePreviewEntry,
  type ModelProtocolVariables,
} from '../../services/ai/modelProtocol';
import PopupCloseButton from '../shared/PopupCloseButton';

type ProtocolChoice = ModelProtocolPresetId | 'legacy';
type EditorView = 'form' | 'json';
type JsonFieldKind = 'object' | 'value';

interface ModelProtocolEditorProps {
  model: ProviderModelSelection;
  onChange: (profile: ModelExecutionProfile | undefined) => void;
  onValidityChange: (valid: boolean) => void;
  onClose: () => void;
}

interface JsonDraftFieldProps {
  fieldId: string;
  label: string;
  value: ProtocolJsonValue | Record<string, string> | undefined;
  kind?: JsonFieldKind;
  rows?: number;
  onChange: (value: ProtocolJsonValue | undefined) => void;
  onValidityChange: (fieldId: string, error?: string) => void;
}

interface ProtocolPreviewState {
  preview?: ModelProtocolRequestPreview;
  error?: string;
}

interface ProtocolResponsePreviewState {
  entries?: ModelProtocolResponsePreviewEntry[];
  error?: string;
}

const PRESET_LABELS: Record<ProtocolChoice, string> = {
  legacy: '自动兼容（旧方式）',
  'openai-chat': 'OpenAI Chat',
  'openai-image': 'OpenAI 同步图片',
  'agnes-video': 'Agnes 异步视频',
  custom: '高级自定义',
};

const CATEGORY_VARIABLES: Record<GeneralModelCategory, string[]> = {
  text: ['model', 'prompt', 'messages', 'stream', 'tools', 'toolChoice'],
  image: ['model', 'prompt', 'imageSize', 'aspectRatio', 'size', 'width', 'height', 'n', 'batchCount', 'imageUrls'],
  video: [
    'model', 'prompt', 'size', 'width', 'height', 'frames', 'frames8n1', 'fps', 'duration',
    'videoResolution', 'videoFrames', 'videoFps', 'seedanceResolution', 'seedanceRatio',
    'seedanceDuration', 'generateAudio',
  ],
  audio: [
    'model', 'prompt', 'audioVoice', 'audioFormat', 'audioSpeed', 'duration',
    'musicTitle', 'musicLyrics', 'musicBpm',
  ],
};

function createPreviewVariables(model: ProviderModelSelection): ModelProtocolVariables {
  const common = {
    model: model.id,
    prompt: 'A cinematic product shot',
  };
  if (model.category === 'text') {
    return {
      ...common,
      messages: [{ role: 'user', content: '介绍这个模型' }],
      stream: false,
    };
  }
  if (model.category === 'image') {
    return {
      ...common,
      imageSize: '1K',
      aspectRatio: '1:1',
      size: '1024x1024',
      width: 1024,
      height: 1024,
      n: 1,
      batchCount: 1,
      imageUrls: ['data:image/png;base64,iVBORw0KGgo='],
    };
  }
  if (model.category === 'video') {
    return {
      ...common,
      size: '1152x768',
      width: 1152,
      height: 768,
      frames: 121,
      frames8n1: 121,
      fps: 24,
      duration: 5,
      videoResolution: 768,
      videoFrames: 121,
      videoFps: 24,
      seedanceResolution: '720p',
      seedanceRatio: '16:9',
      seedanceDuration: 5,
      generateAudio: false,
    };
  }
  return {
    ...common,
    audioVoice: 'alloy',
    audioFormat: 'wav',
    audioSpeed: 1,
    duration: 10,
    musicTitle: 'Sample Track',
    musicLyrics: '',
    musicBpm: 120,
  };
}

function createResponseSample(): ProtocolJsonValue {
  return {
    task_id: 'task_example',
    video_id: 'video_example',
    status: 'completed',
    progress: 100,
    url: 'https://cdn.example/result.mp4',
    data: [{
      url: 'https://cdn.example/result.png',
      b64_json: 'aGVsbG8=',
      caption: '生成完成',
    }],
    result: {
      url: 'https://cdn.example/result.png',
      text: '生成完成',
    },
    choices: [{ message: { content: '生成完成' } }],
    error: null,
  };
}

function getAvailableChoices(category: GeneralModelCategory): ProtocolChoice[] {
  if (category === 'text') return ['legacy', 'openai-chat', 'custom'];
  if (category === 'image') return ['legacy', 'openai-image', 'custom'];
  if (category === 'video') return ['legacy', 'agnes-video', 'custom'];
  return ['legacy', 'custom'];
}

function parseDraft(value: string): { protocol?: NormalizedModelExecutionProtocol; error?: string } {
  try {
    const parsed: unknown = JSON.parse(value);
    const errors = validateModelExecutionProtocol(parsed);
    if (errors.length > 0) return { error: errors[0] };
    return { protocol: parseModelExecutionProtocol(parsed) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : '协议 JSON 无效' };
  }
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function isJsonObject(value: ProtocolJsonValue | undefined): value is Record<string, ProtocolJsonValue> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function JsonDraftField({
  fieldId,
  label,
  value,
  kind = 'object',
  rows = 4,
  onChange,
  onValidityChange,
}: JsonDraftFieldProps) {
  const [draft, setDraft] = useState(() => serializeJson(value));
  const [error, setError] = useState<string | null>(null);

  const updateDraft = (nextDraft: string) => {
    setDraft(nextDraft);
    try {
      const parsed = JSON.parse(nextDraft) as ProtocolJsonValue;
      if (kind === 'object' && !isJsonObject(parsed)) {
        throw new Error('必须是 JSON 对象');
      }
      setError(null);
      onValidityChange(fieldId);
      onChange(parsed);
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : 'JSON 无效';
      setError(message);
      onValidityChange(fieldId, message);
    }
  };

  return (
    <label className="provider-protocol-field provider-protocol-json-field">
      <span>{label}</span>
      <textarea
        value={draft}
        rows={rows}
        spellCheck={false}
        aria-invalid={!!error}
        onChange={(event) => updateDraft(event.target.value)}
      />
      {error ? <small role="alert">{error}</small> : null}
    </label>
  );
}

function createDefaultPoll(category: GeneralModelCategory): ModelProtocolPollTemplate {
  return {
    method: 'GET',
    path: '/tasks/{{submit.task_id}}',
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

export default function ModelProtocolEditor({
  model,
  onChange,
  onValidityChange,
  onClose,
}: ModelProtocolEditorProps) {
  const initialPreset: ProtocolChoice = model.executionProfile?.preset ?? 'legacy';
  const initialProtocol = model.executionProfile?.preset === 'custom' && model.executionProfile.protocol
    ? parseModelExecutionProtocol(model.executionProfile.protocol)
    : getDefaultCustomProtocol(model.category);
  const [preset, setPreset] = useState<ProtocolChoice>(initialPreset);
  const [protocol, setProtocol] = useState<NormalizedModelExecutionProtocol>(initialProtocol);
  const [view, setView] = useState<EditorView>('form');
  const [protocolJson, setProtocolJson] = useState(() => serializeJson(initialProtocol));
  const [error, setError] = useState<string | null>(null);
  const [formRevision, setFormRevision] = useState(0);
  const [previewVariablesJson, setPreviewVariablesJson] = useState(
    () => serializeJson(createPreviewVariables(model)),
  );
  const [responseSampleJson, setResponseSampleJson] = useState(
    () => serializeJson(createResponseSample()),
  );
  const previewVariablesId = useId();
  const previewVariablesErrorId = `${previewVariablesId}-error`;
  const responseSampleId = useId();
  const responseSampleErrorId = `${responseSampleId}-error`;
  const protocolJsonId = useId();
  const protocolJsonHelpId = `${protocolJsonId}-help`;
  const invalidFormFieldsRef = useRef(new Set<string>());

  const publishProtocol = (nextProtocol: NormalizedModelExecutionProtocol) => {
    setProtocol(nextProtocol);
    setProtocolJson(serializeJson(nextProtocol));
    const errors = validateModelExecutionProtocol(nextProtocol);
    setError(errors[0] ?? null);
    const valid = errors.length === 0 && invalidFormFieldsRef.current.size === 0;
    onValidityChange(valid);
    if (valid) onChange({ preset: 'custom', protocol: parseModelExecutionProtocol(nextProtocol) });
  };

  const updateProtocol = (mutate: (draft: NormalizedModelExecutionProtocol) => void) => {
    const nextProtocol = structuredClone(protocol);
    mutate(nextProtocol);
    publishProtocol(nextProtocol);
  };

  const updateFormValidity = (fieldId: string, fieldError?: string) => {
    if (fieldError) invalidFormFieldsRef.current.add(fieldId);
    else invalidFormFieldsRef.current.delete(fieldId);
    const protocolErrors = validateModelExecutionProtocol(protocol);
    setError(protocolErrors[0] ?? null);
    onValidityChange(protocolErrors.length === 0 && invalidFormFieldsRef.current.size === 0);
  };

  const updateCustomJson = (value: string) => {
    setProtocolJson(value);
    const parsed = parseDraft(value);
    setError(parsed.error ?? null);
    onValidityChange(!!parsed.protocol);
    if (parsed.protocol) {
      invalidFormFieldsRef.current.clear();
      setProtocol(parsed.protocol);
      onChange({ preset: 'custom', protocol: parsed.protocol });
    }
  };

  const changeView = (nextView: EditorView) => {
    invalidFormFieldsRef.current.clear();
    setError(null);
    setProtocolJson(serializeJson(protocol));
    setView(nextView);
    const valid = validateModelExecutionProtocol(protocol).length === 0;
    onValidityChange(valid);
  };

  const changePreset = (nextPreset: ProtocolChoice) => {
    setPreset(nextPreset);
    setError(null);
    invalidFormFieldsRef.current.clear();
    if (nextPreset === 'legacy') {
      onValidityChange(true);
      onChange(undefined);
      return;
    }
    if (nextPreset === 'custom') {
      const nextProtocol = preset !== 'legacy' && preset !== 'custom'
        ? getModelProtocolPreset(preset)
        : protocol;
      publishProtocol(nextProtocol);
      return;
    }
    const nextProtocol = getModelProtocolPreset(nextPreset);
    setProtocol(nextProtocol);
    setProtocolJson(serializeJson(nextProtocol));
    onValidityChange(true);
    onChange({ preset: nextPreset });
  };

  const changeMode = (mode: ModelExecutionProtocol['mode']) => {
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
      draft.submit.body = body;
    });
    setFormRevision((current) => current + 1);
  };

  const insertMultipartFile = (fieldName: string) => {
    if (!fieldName) return;
    updateProtocol((draft) => {
      const body = isJsonObject(draft.submit.body) ? draft.submit.body : {};
      body[fieldName] = {
        $file: '{{imageUrls.0}}',
        filename: 'reference.png',
      };
      draft.submit.bodyEncoding = 'multipart';
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

  const auth = protocol.auth ?? { type: 'bearer' as const };
  const poll = protocol.poll;
  const responseResult = protocol.response.result ?? {};
  const pollResponse = poll?.response;
  const pollResult = pollResponse?.result;
  const pollRetry = {
    ...getDefaultModelProtocolPollRetryConfig(),
    ...poll?.retry,
  };
  const previewState = useMemo<ProtocolPreviewState>(() => {
    if (preset !== 'custom') return {};
    try {
      const parsed = JSON.parse(previewVariablesJson) as ProtocolJsonValue;
      if (!isJsonObject(parsed)) throw new Error('示例变量必须是 JSON 对象');
      return {
        preview: previewModelProtocolRequest({
          baseUrl: 'https://preview.invalid',
          protocol,
          variables: parsed,
        }),
      };
    } catch (previewError) {
      return {
        error: previewError instanceof Error ? previewError.message : '请求预览失败',
      };
    }
  }, [preset, previewVariablesJson, protocol]);
  const supportsStructuredResponse = protocol.mode === 'async'
    || protocol.response.type === 'json';
  const responsePreviewState = useMemo<ProtocolResponsePreviewState>(() => {
    if (preset !== 'custom' || !supportsStructuredResponse) return {};
    try {
      const parsed = JSON.parse(responseSampleJson) as ProtocolJsonValue;
      if (!isJsonObject(parsed) && !Array.isArray(parsed)) {
        throw new Error('响应示例必须是 JSON 对象或数组');
      }
      return { entries: previewModelProtocolResponse(protocol, parsed) };
    } catch (previewError) {
      return {
        error: previewError instanceof Error ? previewError.message : '返回值结构预览失败',
      };
    }
  }, [preset, protocol, responseSampleJson, supportsStructuredResponse]);

  return (
    <section className="provider-protocol-editor is-small" aria-label={`${model.name} 调用协议`}>
      <div className="provider-protocol-editor-head">
        <div>
          <span>模型调用协议</span>
          <strong>{model.name}</strong>
        </div>
        <PopupCloseButton ariaLabel="关闭协议设置" onClick={onClose} />
      </div>

      <div className="provider-protocol-topbar">
        <label className="provider-protocol-field">
          <span>协议预设</span>
          <select value={preset} onChange={(event) => changePreset(event.target.value as ProtocolChoice)}>
            {getAvailableChoices(model.category).map((choice) => (
              <option key={choice} value={choice}>{PRESET_LABELS[choice]}</option>
            ))}
          </select>
        </label>
        {preset === 'custom' ? (
          <div className="provider-protocol-view-tabs" role="tablist" aria-label="协议编辑方式">
            <button type="button" role="tab" aria-selected={view === 'form'} className={view === 'form' ? 'is-active' : ''} onClick={() => changeView('form')}>
              表单
            </button>
            <button type="button" role="tab" aria-selected={view === 'json'} className={view === 'json' ? 'is-active' : ''} onClick={() => changeView('json')}>
              JSON
            </button>
          </div>
        ) : null}
      </div>

      {preset === 'custom' && view === 'form' ? (
        <div className="provider-protocol-form">
          <section className="provider-protocol-form-section">
            <div className="provider-protocol-section-title">
              <Icon icon="mdi:shield-key-outline" width="14" />
              <span>协议与鉴权</span>
            </div>
            <div className="provider-protocol-grid is-three">
              <label className="provider-protocol-field">
                <span>执行模式</span>
                <select value={protocol.mode} onChange={(event) => changeMode(event.target.value as ModelExecutionProtocol['mode'])}>
                  <option value="sync">同步返回</option>
                  <option value="async">异步轮询</option>
                </select>
              </label>
              <label className="provider-protocol-field">
                <span>鉴权方式</span>
                <select value={auth.type} onChange={(event) => changeAuthType(event.target.value as ModelProtocolAuthType)}>
                  <option value="bearer">Bearer</option>
                  <option value="header">自定义 Header</option>
                  <option value="query">Query 参数</option>
                  <option value="none">无需鉴权</option>
                </select>
              </label>
              {auth.type === 'header' || auth.type === 'query' ? (
                <label className="provider-protocol-field">
                  <span>{auth.type === 'header' ? 'Header 名称' : 'Query 名称'}</span>
                  <input
                    value={auth.name ?? ''}
                    onChange={(event) => updateProtocol((draft) => {
                      draft.auth = { ...auth, name: event.target.value };
                    })}
                  />
                </label>
              ) : (
                <label className="provider-protocol-field">
                  <span>密钥前缀</span>
                  <input
                    value={auth.prefix ?? ''}
                    placeholder={auth.type === 'bearer' ? 'Bearer ' : ''}
                    disabled={auth.type === 'none'}
                    onChange={(event) => updateProtocol((draft) => {
                      draft.auth = { ...auth, prefix: event.target.value };
                    })}
                  />
                </label>
              )}
            </div>
            {auth.type === 'header' || auth.type === 'query' ? (
              <label className="provider-protocol-field provider-protocol-prefix-field">
                <span>密钥前缀</span>
                <input
                  value={auth.prefix ?? ''}
                  placeholder="可选"
                  onChange={(event) => updateProtocol((draft) => {
                    draft.auth = { ...auth, prefix: event.target.value };
                  })}
                />
              </label>
            ) : null}
            {model.category === 'text' ? (
              <label className="provider-protocol-toggle">
                <input
                  type="checkbox"
                  checked={protocol.streamFormat === 'openai-sse'}
                  onChange={(event) => updateProtocol((draft) => {
                    if (event.target.checked) draft.streamFormat = 'openai-sse';
                    else delete draft.streamFormat;
                  })}
                />
                <span>OpenAI SSE 对话兼容</span>
              </label>
            ) : null}
          </section>

          <section className="provider-protocol-form-section">
            <div className="provider-protocol-section-title">
              <Icon icon="mdi:send-outline" width="14" />
              <span>提交请求</span>
            </div>
            <div className="provider-protocol-grid is-request">
              <label className="provider-protocol-field">
                <span>方法</span>
                <select value={protocol.submit.method} onChange={(event) => updateSubmit({ method: event.target.value as 'GET' | 'POST' })}>
                  <option value="POST">POST</option>
                  <option value="GET">GET</option>
                </select>
              </label>
              <label className="provider-protocol-field">
                <span>路径</span>
                <input value={protocol.submit.path} onChange={(event) => updateSubmit({ path: event.target.value })} />
              </label>
              <label className="provider-protocol-field">
                <span>路径基准</span>
                <select value={protocol.submit.pathMode ?? 'append'} onChange={(event) => updateSubmit({ pathMode: event.target.value as 'append' | 'origin' })}>
                  <option value="append">连接地址</option>
                  <option value="origin">域名根路径</option>
                </select>
              </label>
            </div>
            <div className="provider-protocol-grid">
              <label className="provider-protocol-field">
                <span>请求体编码</span>
                <select
                  value={protocol.submit.bodyEncoding ?? 'json'}
                  onChange={(event) => updateSubmit({
                    bodyEncoding: event.target.value as ModelProtocolBodyEncoding,
                  })}
                >
                  <option value="json">JSON</option>
                  <option value="form-urlencoded">Form URL Encoded</option>
                  <option value="multipart">Multipart Form Data</option>
                </select>
              </label>
              {model.category === 'image' || model.category === 'video' ? (
                <label className="provider-protocol-field provider-protocol-size-insert">
                  <span>插入尺寸字段</span>
                  <select value="" onChange={(event) => insertSizeMapping(event.target.value)}>
                    <option value="">选择映射</option>
                    <option value="size">size: widthxheight</option>
                    <option value="dimensions">width + height</option>
                    {model.category === 'image' ? <option value="image-semantic">resolution + aspect_ratio</option> : null}
                    {model.category === 'video' ? <option value="video-standard">resolution + num_frames + frame_rate</option> : null}
                    {model.category === 'video' ? <option value="seedance">Seedance resolution + ratio + duration</option> : null}
                  </select>
                </label>
              ) : null}
              {model.category === 'image' && protocol.submit.bodyEncoding === 'multipart' ? (
                <label className="provider-protocol-field">
                  <span>插入文件字段</span>
                  <select value="" onChange={(event) => insertMultipartFile(event.target.value)}>
                    <option value="">选择字段</option>
                    <option value="image">image: imageUrls.0</option>
                    <option value="file">file: imageUrls.0</option>
                    <option value="reference_image">reference_image: imageUrls.0</option>
                  </select>
                </label>
              ) : null}
            </div>
            <div className="provider-protocol-json-grid">
              <JsonDraftField
                fieldId="submit-headers"
                label="请求头 JSON"
                value={protocol.submit.headers}
                rows={4}
                onValidityChange={updateFormValidity}
                onChange={(value) => updateSubmit({ headers: value as Record<string, string> })}
              />
              <JsonDraftField
                fieldId="submit-query"
                label="Query JSON"
                value={protocol.submit.query}
                rows={4}
                onValidityChange={updateFormValidity}
                onChange={(value) => updateSubmit({ query: value as Record<string, ProtocolJsonValue> })}
              />
            </div>
            <JsonDraftField
              key={`submit-body-${formRevision}`}
              fieldId="submit-body"
              label="请求体 JSON"
              value={protocol.submit.body}
              kind="value"
              rows={8}
              onValidityChange={updateFormValidity}
              onChange={(value) => updateSubmit({ body: value })}
            />
          </section>

          <section className="provider-protocol-form-section">
            <div className="provider-protocol-section-title">
              <Icon icon="mdi:code-json" width="14" />
              <span>{protocol.mode === 'sync' ? '返回值结构' : '任务与返回值结构'}</span>
            </div>
            {protocol.mode === 'sync' ? (
              <>
                <div className="provider-protocol-grid is-three">
                  <label className="provider-protocol-field">
                    <span>响应类型</span>
                    <select
                      value={protocol.response.type}
                      onChange={(event) => changeResponseType(event.target.value as ModelProtocolResponseType)}
                    >
                      <option value="json">JSON</option>
                      <option value="text">原始文本</option>
                      <option value="binary">原始二进制</option>
                    </select>
                  </label>
                  {protocol.response.type === 'binary' ? (
                    <label className="provider-protocol-field">
                      <span>备用 MIME 类型</span>
                      <input
                        value={responseResult.mimeType ?? ''}
                        placeholder={model.category === 'video' ? 'video/mp4' : model.category === 'audio' ? 'audio/mpeg' : 'image/png'}
                        onChange={(event) => updateResponseResult({ mimeType: event.target.value || undefined })}
                      />
                    </label>
                  ) : null}
                  <label className="provider-protocol-field">
                    <span>错误路径</span>
                    <input
                      value={protocol.response.errorPath ?? ''}
                      onChange={(event) => updateResponse({ errorPath: event.target.value || undefined })}
                    />
                  </label>
                </div>
                {protocol.response.type === 'json' ? (
                  <div className="provider-protocol-grid is-three">
                    <label className="provider-protocol-field">
                      <span>URL 结果路径</span>
                      <input
                        value={responseResult.urlPath ?? ''}
                        onChange={(event) => updateResponseResult({ urlPath: event.target.value || undefined })}
                      />
                    </label>
                    <label className="provider-protocol-field">
                      <span>文本结果路径</span>
                      <input
                        value={responseResult.textPath ?? ''}
                        onChange={(event) => updateResponseResult({ textPath: event.target.value || undefined })}
                      />
                    </label>
                    <label className="provider-protocol-field">
                      <span>Base64 结果路径</span>
                      <input
                        value={responseResult.base64Path ?? ''}
                        onChange={(event) => updateResponseResult({ base64Path: event.target.value || undefined })}
                      />
                    </label>
                    {responseResult.base64Path ? (
                      <label className="provider-protocol-field">
                        <span>Base64 MIME 类型</span>
                        <input
                          value={responseResult.mimeType ?? ''}
                          placeholder={model.category === 'video' ? 'video/mp4' : model.category === 'audio' ? 'audio/mpeg' : 'image/png'}
                          onChange={(event) => updateResponseResult({ mimeType: event.target.value || undefined })}
                        />
                      </label>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : poll ? (
              <>
                <div className="provider-protocol-grid">
                  <label className="provider-protocol-field">
                    <span>任务 ID 路径</span>
                    <input
                      value={protocol.response.taskIdPath ?? ''}
                      onChange={(event) => updateResponse({ taskIdPath: event.target.value })}
                    />
                  </label>
                  <label className="provider-protocol-field">
                    <span>轮询方法</span>
                    <select value={poll.method} onChange={(event) => updatePoll({ method: event.target.value as 'GET' | 'POST' })}>
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                    </select>
                  </label>
                  <label className="provider-protocol-field">
                    <span>轮询间隔 ms</span>
                    <input type="number" min={1000} max={60000} value={poll.intervalMs ?? 3000} onChange={(event) => updatePoll({ intervalMs: Number(event.target.value) })} />
                  </label>
                  <label className="provider-protocol-field">
                    <span>轮询请求体编码</span>
                    <select
                      value={poll.bodyEncoding ?? 'json'}
                      onChange={(event) => updatePoll({
                        bodyEncoding: event.target.value as Exclude<ModelProtocolBodyEncoding, 'multipart'>,
                      })}
                    >
                      <option value="json">JSON</option>
                      <option value="form-urlencoded">Form URL Encoded</option>
                    </select>
                  </label>
                </div>
                <div className="provider-protocol-grid is-request">
                  <label className="provider-protocol-field provider-protocol-path-field">
                    <span>轮询路径</span>
                    <input value={poll.path} onChange={(event) => updatePoll({ path: event.target.value })} />
                  </label>
                  <label className="provider-protocol-field">
                    <span>路径基准</span>
                    <select value={poll.pathMode ?? 'append'} onChange={(event) => updatePoll({ pathMode: event.target.value as 'append' | 'origin' })}>
                      <option value="append">连接地址</option>
                      <option value="origin">域名根路径</option>
                    </select>
                  </label>
                </div>
                <div className="provider-protocol-json-grid">
                  <JsonDraftField
                    fieldId="poll-headers"
                    label="轮询请求头 JSON"
                    value={poll.headers}
                    rows={4}
                    onValidityChange={updateFormValidity}
                    onChange={(value) => updatePoll({ headers: value as Record<string, string> })}
                  />
                  <JsonDraftField
                    fieldId="poll-query"
                    label="轮询 Query JSON"
                    value={poll.query}
                    rows={4}
                    onValidityChange={updateFormValidity}
                    onChange={(value) => updatePoll({ query: value as Record<string, ProtocolJsonValue> })}
                  />
                </div>
                <JsonDraftField
                  fieldId="poll-body"
                  label="轮询请求体 JSON"
                  value={poll.body}
                  kind="value"
                  rows={5}
                  onValidityChange={updateFormValidity}
                  onChange={(value) => updatePoll({ body: value })}
                />
                <div className="provider-protocol-grid is-three">
                  <label className="provider-protocol-field">
                    <span>状态路径</span>
                    <input value={pollResponse?.statusPath ?? ''} onChange={(event) => updatePollResponse({ statusPath: event.target.value })} />
                  </label>
                  <label className="provider-protocol-field">
                    <span>成功状态</span>
                    <input value={pollResponse?.successValues.join(', ') ?? ''} onChange={(event) => updatePollResponse({ successValues: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} />
                  </label>
                  <label className="provider-protocol-field">
                    <span>失败状态</span>
                    <input value={pollResponse?.failureValues.join(', ') ?? ''} onChange={(event) => updatePollResponse({ failureValues: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} />
                  </label>
                </div>
                <div className="provider-protocol-grid is-three">
                  <label className="provider-protocol-field">
                    <span>URL 结果路径</span>
                    <input value={pollResult?.urlPath ?? ''} onChange={(event) => updatePollResult({
                      urlPath: event.target.value || undefined,
                    })} />
                  </label>
                  <label className="provider-protocol-field">
                    <span>文本结果路径</span>
                    <input value={pollResult?.textPath ?? ''} onChange={(event) => updatePollResult({
                      textPath: event.target.value || undefined,
                    })} />
                  </label>
                  <label className="provider-protocol-field">
                    <span>Base64 结果路径</span>
                    <input value={pollResult?.base64Path ?? ''} onChange={(event) => updatePollResult({
                      base64Path: event.target.value || undefined,
                    })} />
                  </label>
                  {pollResult?.base64Path ? (
                    <label className="provider-protocol-field">
                      <span>Base64 MIME 类型</span>
                      <input
                        value={pollResult.mimeType ?? ''}
                        placeholder={model.category === 'video' ? 'video/mp4' : model.category === 'audio' ? 'audio/mpeg' : 'image/png'}
                        onChange={(event) => updatePollResult({ mimeType: event.target.value || undefined })}
                      />
                    </label>
                  ) : null}
                </div>
                <div className="provider-protocol-grid">
                  <label className="provider-protocol-field">
                    <span>错误路径</span>
                    <input value={pollResponse?.errorPath ?? ''} onChange={(event) => updatePollResponse({ errorPath: event.target.value || undefined })} />
                  </label>
                  <label className="provider-protocol-field">
                    <span>进度路径</span>
                    <input value={pollResponse?.progressPath ?? ''} onChange={(event) => updatePollResponse({ progressPath: event.target.value || undefined })} />
                  </label>
                </div>
                <details className="border-t border-canvas-border pt-2.5 text-[12px] text-canvas-text-muted">
                  <summary className="w-fit cursor-pointer select-none text-canvas-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canvas-text-muted">
                    轮询与重试策略
                  </summary>
                  <div className="mt-2 flex min-w-0 flex-col gap-2">
                    <div className="provider-protocol-grid is-three">
                      <label className="provider-protocol-field">
                        <span>最大轮询次数</span>
                        <input
                          type="number"
                          min={1}
                          max={10000}
                          value={poll.maxAttempts ?? ''}
                          onChange={(event) => updatePoll({
                            maxAttempts: Number.isFinite(event.target.valueAsNumber)
                              ? event.target.valueAsNumber
                              : undefined,
                          })}
                        />
                      </label>
                      <label className="provider-protocol-field">
                        <span>最长时长（秒）</span>
                        <input
                          type="number"
                          min={1}
                          max={86400}
                          value={poll.maxDurationMs === undefined ? '' : poll.maxDurationMs / 1000}
                          onChange={(event) => updatePoll({
                            maxDurationMs: Number.isFinite(event.target.valueAsNumber)
                              ? Math.round(event.target.valueAsNumber * 1000)
                              : undefined,
                          })}
                        />
                      </label>
                      <label className="provider-protocol-field">
                        <span>错误重试次数</span>
                        <input
                          type="number"
                          min={0}
                          max={10}
                          value={pollRetry.maxRetries}
                          onChange={(event) => updatePollRetry({ maxRetries: event.target.valueAsNumber })}
                        />
                      </label>
                    </div>
                    <div className="provider-protocol-grid is-three">
                      <label className="provider-protocol-field">
                        <span>退避策略</span>
                        <select
                          value={pollRetry.backoff}
                          onChange={(event) => updatePollRetry({
                            backoff: event.target.value as ModelProtocolPollRetryConfig['backoff'],
                          })}
                        >
                          <option value="fixed">固定间隔</option>
                          <option value="linear">线性增加</option>
                          <option value="exponential">指数增加</option>
                        </select>
                      </label>
                      <label className="provider-protocol-field">
                        <span>最大重试间隔 ms</span>
                        <input
                          type="number"
                          min={1000}
                          max={300000}
                          value={pollRetry.maxDelayMs}
                          onChange={(event) => updatePollRetry({ maxDelayMs: event.target.valueAsNumber })}
                        />
                      </label>
                      <label className="provider-protocol-field">
                        <span>重试 HTTP 状态码</span>
                        <input
                          value={pollRetry.httpStatuses.join(', ')}
                          onChange={(event) => updatePollRetry({
                            httpStatuses: event.target.value
                              .split(',')
                              .map((item) => item.trim())
                              .filter(Boolean)
                              .map(Number),
                          })}
                        />
                      </label>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <label className="provider-protocol-toggle">
                        <input
                          type="checkbox"
                          checked={pollRetry.honorRetryAfter}
                          onChange={(event) => updatePollRetry({ honorRetryAfter: event.target.checked })}
                        />
                        <span>遵循 Retry-After</span>
                      </label>
                      <label className="provider-protocol-toggle">
                        <input
                          type="checkbox"
                          checked={pollRetry.retryNetworkErrors}
                          onChange={(event) => updatePollRetry({ retryNetworkErrors: event.target.checked })}
                        />
                        <span>重试网络错误</span>
                      </label>
                    </div>
                  </div>
                </details>
              </>
            ) : null}
            {supportsStructuredResponse ? (
              <details className="provider-protocol-response-preview" open>
                <summary>响应示例与路径校验</summary>
                <div className="provider-protocol-response-preview-content">
                  <div className="provider-protocol-field min-w-0">
                    <label htmlFor={responseSampleId}>响应示例 JSON</label>
                    <textarea
                      id={responseSampleId}
                      value={responseSampleJson}
                      rows={8}
                      spellCheck={false}
                      autoComplete="off"
                      aria-invalid={!!responsePreviewState.error}
                      aria-describedby={responsePreviewState.error ? responseSampleErrorId : undefined}
                      onChange={(event) => setResponseSampleJson(event.target.value)}
                    />
                    {responsePreviewState.error ? (
                      <small id={responseSampleErrorId} role="alert">
                        {responsePreviewState.error}
                      </small>
                    ) : null}
                  </div>
                  <div className="provider-protocol-response-results" aria-live="polite">
                    <span>路径解析结果</span>
                    {responsePreviewState.entries?.map((entry) => (
                      <div key={entry.id} className="provider-protocol-response-result">
                        <div>
                          <strong>{entry.label}</strong>
                          <code>{entry.path}</code>
                        </div>
                        <code className={entry.matchCount > 0 ? 'is-matched' : ''}>
                          {entry.matchCount > 0 ? entry.values.join(' | ') : '未匹配'}
                        </code>
                      </div>
                    ))}
                  </div>
                </div>
              </details>
            ) : null}
          </section>

          <details className="provider-protocol-variables">
            <summary>可用变量</summary>
            <div>
              {CATEGORY_VARIABLES[model.category].map((variable) => (
                <code key={variable}>{`{{${variable}}}`}</code>
              ))}
              {protocol.mode === 'async' ? <code>{'{{submit.task_id}}'}</code> : null}
            </div>
          </details>

          <details className="border-t border-canvas-border pt-2.5 text-[12px] text-canvas-text-muted">
            <summary className="w-fit cursor-pointer select-none text-canvas-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canvas-text-muted">
              本地请求预览
            </summary>
            <div className="mt-2 grid min-w-0 grid-cols-2 gap-2 max-[700px]:grid-cols-1">
              <div className="provider-protocol-field min-w-0">
                <label htmlFor={previewVariablesId} className="text-[12px] text-canvas-text-muted">
                  示例变量 JSON
                </label>
                <textarea
                  id={previewVariablesId}
                  value={previewVariablesJson}
                  rows={10}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={!!previewState.error}
                  aria-describedby={previewState.error ? previewVariablesErrorId : undefined}
                  onChange={(event) => setPreviewVariablesJson(event.target.value)}
                />
                {previewState.error ? (
                  <small id={previewVariablesErrorId} role="alert" className="text-[var(--danger-light)]">
                    {previewState.error}
                  </small>
                ) : null}
              </div>
              <div className="flex min-w-0 flex-col gap-2" aria-live="polite">
                <div className="flex min-w-0 items-center gap-2 rounded-md border border-canvas-border bg-canvas-bg/40 px-2.5 py-2">
                  <span className="shrink-0 font-mono text-[12px] font-semibold text-canvas-text-secondary">
                    {previewState.preview?.method ?? '--'}
                  </span>
                  <code className="min-w-0 break-all text-[12px] text-canvas-text">
                    {previewState.preview?.relativeUrl ?? '请求路径不可用'}
                  </code>
                </div>
                <div className="provider-protocol-field min-w-0">
                  <span>Header 预览</span>
                  <pre className="max-h-32 min-h-20 overflow-auto whitespace-pre-wrap break-all rounded-md border border-canvas-border bg-canvas-bg/40 p-2.5 font-mono text-[12px] leading-relaxed text-canvas-text-secondary">
                    {previewState.preview ? serializeJson(previewState.preview.headers) : '{}'}
                  </pre>
                </div>
                <div className="provider-protocol-field min-w-0">
                  <span>Body 预览</span>
                  <pre className="max-h-48 min-h-28 overflow-auto whitespace-pre-wrap break-all rounded-md border border-canvas-border bg-canvas-bg/40 p-2.5 font-mono text-[12px] leading-relaxed text-canvas-text-secondary">
                    {previewState.preview?.body === undefined ? '无请求体' : serializeJson(previewState.preview.body)}
                  </pre>
                </div>
              </div>
            </div>
          </details>
        </div>
      ) : null}

      {preset === 'custom' && view === 'json' ? (
        <div className="provider-protocol-field provider-protocol-full-json">
          <div className="provider-protocol-json-variables" aria-label="当前模型可用变量">
            <div className="provider-protocol-json-guide-title">
              <Icon icon="mdi:code-braces" width="13" />
              <strong>可用变量</strong>
              <span>可放入 path、query、headers 或 body，调用时会替换为节点中的实际值</span>
            </div>
            <div className="provider-protocol-json-variable-list">
              {CATEGORY_VARIABLES[model.category].map((variable) => (
                <code key={variable}>{`{{${variable}}}`}</code>
              ))}
              {protocol.mode === 'async' ? (
                <code title="仅用于 poll：提交响应中解析出的任务 ID">{'{{submit.task_id}}'}</code>
              ) : null}
            </div>
          </div>

          <label htmlFor={protocolJsonId}>声明式协议 JSON</label>
          <textarea
            id={protocolJsonId}
            value={protocolJson}
            spellCheck={false}
            aria-invalid={!!error}
            aria-describedby={protocolJsonHelpId}
            onChange={(event) => updateCustomJson(event.target.value)}
          />

          <aside id={protocolJsonHelpId} className="provider-protocol-json-help">
            <div className="provider-protocol-json-guide-title">
              <Icon icon="mdi:information-outline" width="13" />
              <strong>配置说明</strong>
              <span>不确定如何填写时，可先在“表单”模式配置，再切回 JSON 查看结果</span>
            </div>
            <dl>
              <div>
                <dt><code>version</code> / <code>mode</code></dt>
                <dd>协议版本固定为 2；mode 使用 <code>sync</code> 同步返回或 <code>async</code> 异步轮询。</dd>
              </div>
              <div>
                <dt><code>auth</code></dt>
                <dd>定义 API Key 的注入方式。只配置 type、name、prefix，不要把真实密钥写进 JSON。</dd>
              </div>
              <div>
                <dt><code>submit</code></dt>
                <dd>首次请求规则，包括 method、path、query、headers、bodyEncoding 和 body。</dd>
              </div>
              <div>
                <dt><code>response</code></dt>
                <dd>首次响应的解析规则。同步模式从 result 取结果；异步模式用 taskIdPath 取得任务 ID。</dd>
              </div>
              <div>
                <dt><code>poll</code></dt>
                <dd>仅异步模式需要，定义查询请求、完成/失败状态、结果路径、查询间隔与重试策略。</dd>
              </div>
              <div>
                <dt>响应路径</dt>
                <dd>用点号读取嵌套字段，例如 <code>data.0.url</code>；用 <code>data.*.url</code> 读取数组内全部 URL。</dd>
              </div>
            </dl>
            {protocol.mode === 'async' ? (
              <p>
                异步流程先按 <code>response.taskIdPath</code> 取得任务 ID，再在 poll 中通过
                {' '}<code>{'{{submit.task_id}}'}</code> 引用。
              </p>
            ) : null}
          </aside>
        </div>
      ) : null}

      {error ? (
        <div className="provider-protocol-error" role="alert">
          <Icon icon="mdi:alert-circle-outline" width="14" />
          <span>{error}</span>
        </div>
      ) : null}
    </section>
  );
}
