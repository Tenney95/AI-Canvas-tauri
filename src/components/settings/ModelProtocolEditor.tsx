import { Icon } from '@iconify/react';
import { useRef, useState } from 'react';
import type { GeneralModelCategory, ProviderModelSelection } from '../../types';
import type {
  ModelExecutionProfile,
  ModelExecutionProtocol,
  ModelProtocolAuthType,
  ModelProtocolPollTemplate,
  ModelProtocolPresetId,
  ModelProtocolRequestTemplate,
  ProtocolJsonValue,
} from '../../types/aiTypes';
import {
  getDefaultCustomProtocol,
  getModelProtocolPreset,
  parseModelExecutionProtocol,
  validateModelExecutionProtocol,
} from '../../services/ai/modelProtocol';
import AnimatedButton from '../shared/AnimatedButton';

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

function getAvailableChoices(category: GeneralModelCategory): ProtocolChoice[] {
  if (category === 'text') return ['legacy', 'openai-chat', 'custom'];
  if (category === 'image') return ['legacy', 'openai-image', 'custom'];
  if (category === 'video') return ['legacy', 'agnes-video', 'custom'];
  return ['legacy', 'custom'];
}

function parseDraft(value: string): { protocol?: ModelExecutionProtocol; error?: string } {
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
    statusPath: 'status',
    successValues: ['completed'],
    failureValues: ['failed', 'error'],
    ...(category === 'text' ? { resultTextPath: 'result.text' } : { resultUrlPath: 'url' }),
    errorPath: 'error.message',
    progressPath: 'progress',
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
    ? model.executionProfile.protocol
    : getDefaultCustomProtocol(model.category);
  const [preset, setPreset] = useState<ProtocolChoice>(initialPreset);
  const [protocol, setProtocol] = useState<ModelExecutionProtocol>(initialProtocol);
  const [view, setView] = useState<EditorView>('form');
  const [protocolJson, setProtocolJson] = useState(() => serializeJson(initialProtocol));
  const [error, setError] = useState<string | null>(null);
  const [formRevision, setFormRevision] = useState(0);
  const invalidFormFieldsRef = useRef(new Set<string>());

  const publishProtocol = (nextProtocol: ModelExecutionProtocol) => {
    setProtocol(nextProtocol);
    setProtocolJson(serializeJson(nextProtocol));
    const errors = validateModelExecutionProtocol(nextProtocol);
    setError(errors[0] ?? null);
    const valid = errors.length === 0 && invalidFormFieldsRef.current.size === 0;
    onValidityChange(valid);
    if (valid) onChange({ preset: 'custom', protocol: parseModelExecutionProtocol(nextProtocol) });
  };

  const updateProtocol = (mutate: (draft: ModelExecutionProtocol) => void) => {
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
        delete draft.taskIdPath;
        delete draft.poll;
        if (model.category === 'text') {
          draft.resultTextPath ??= 'choices.0.message.content';
          delete draft.resultUrlPath;
        } else {
          draft.resultUrlPath ??= 'data.*.url';
          delete draft.resultTextPath;
        }
      } else {
        delete draft.resultUrlPath;
        delete draft.resultTextPath;
        draft.taskIdPath ??= 'task_id';
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

  const auth = protocol.auth ?? { type: 'bearer' as const };
  const poll = protocol.poll;

  return (
    <section className="provider-protocol-editor" aria-label={`${model.name} 调用协议`}>
      <div className="provider-protocol-editor-head">
        <div>
          <span>模型调用协议</span>
          <strong>{model.name}</strong>
        </div>
        <AnimatedButton
          type="button"
          className="provider-icon-btn"
          aria-label="关闭协议设置"
          onClick={onClose}
        >
          <Icon icon="mdi:close" width="15" />
        </AnimatedButton>
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
              <span>{protocol.mode === 'sync' ? '响应解析' : '任务与轮询'}</span>
            </div>
            {protocol.mode === 'sync' ? (
              <div className="provider-protocol-grid">
                <label className="provider-protocol-field">
                  <span>{model.category === 'text' ? '文本结果路径' : 'URL 结果路径'}</span>
                  <input
                    value={model.category === 'text' ? protocol.resultTextPath ?? '' : protocol.resultUrlPath ?? ''}
                    onChange={(event) => updateProtocol((draft) => {
                      if (model.category === 'text') draft.resultTextPath = event.target.value;
                      else draft.resultUrlPath = event.target.value;
                    })}
                  />
                </label>
                <label className="provider-protocol-field">
                  <span>错误路径</span>
                  <input value={protocol.errorPath ?? ''} onChange={(event) => updateProtocol((draft) => {
                    draft.errorPath = event.target.value || undefined;
                  })} />
                </label>
              </div>
            ) : poll ? (
              <>
                <div className="provider-protocol-grid is-three">
                  <label className="provider-protocol-field">
                    <span>任务 ID 路径</span>
                    <input value={protocol.taskIdPath ?? ''} onChange={(event) => updateProtocol((draft) => {
                      draft.taskIdPath = event.target.value;
                    })} />
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
                    <input value={poll.statusPath} onChange={(event) => updatePoll({ statusPath: event.target.value })} />
                  </label>
                  <label className="provider-protocol-field">
                    <span>成功状态</span>
                    <input value={poll.successValues.join(', ')} onChange={(event) => updatePoll({ successValues: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} />
                  </label>
                  <label className="provider-protocol-field">
                    <span>失败状态</span>
                    <input value={poll.failureValues.join(', ')} onChange={(event) => updatePoll({ failureValues: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} />
                  </label>
                </div>
                <div className="provider-protocol-grid is-three">
                  <label className="provider-protocol-field">
                    <span>{model.category === 'text' ? '文本结果路径' : 'URL 结果路径'}</span>
                    <input
                      value={model.category === 'text' ? poll.resultTextPath ?? '' : poll.resultUrlPath ?? ''}
                      onChange={(event) => updatePoll(model.category === 'text'
                        ? { resultTextPath: event.target.value }
                        : { resultUrlPath: event.target.value })}
                    />
                  </label>
                  <label className="provider-protocol-field">
                    <span>错误路径</span>
                    <input value={poll.errorPath ?? ''} onChange={(event) => updatePoll({ errorPath: event.target.value || undefined })} />
                  </label>
                  <label className="provider-protocol-field">
                    <span>进度路径</span>
                    <input value={poll.progressPath ?? ''} onChange={(event) => updatePoll({ progressPath: event.target.value || undefined })} />
                  </label>
                </div>
              </>
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
        </div>
      ) : null}

      {preset === 'custom' && view === 'json' ? (
        <label className="provider-protocol-field provider-protocol-full-json">
          <span>声明式协议 JSON</span>
          <textarea
            value={protocolJson}
            spellCheck={false}
            aria-invalid={!!error}
            onChange={(event) => updateCustomJson(event.target.value)}
          />
        </label>
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
