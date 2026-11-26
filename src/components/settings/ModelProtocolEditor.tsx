/**
 * 编辑自定义模型的请求、鉴权、轮询与响应映射协议，并在保存前执行结构校验。
 */
import Select from '../shared/Select';
import { Icon } from '@iconify/react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type {
  ImageReferenceRequestMode,
  ProviderModelSelection,
} from '../../types';
import type {
  ModelExecutionProfile,
  ModelExecutionProtocol,
  NormalizedModelExecutionProtocol,
  ModelProtocolAuthType,
  ModelProtocolBodyEncoding,
  ModelProtocolPollRetryConfig,
  ModelProtocolResponseType,
  ProtocolJsonValue,
  VideoModelCapability,
} from '../../types/aiTypes';
import {
  getDefaultCustomProtocol,
  getDefaultModelProtocolPollRetryConfig,
  getModelProtocolPreset,
  parseModelExecutionProtocol,
  type ModelProtocolVariables,
} from '../../services/ai/modelProtocol';
import { getProtocolVariableDescription } from '../../services/ai/modelProtocolVariables';
import PopupCloseButton from '../shared/PopupCloseButton';
import {
  defaultVideoTestScenario,
  pluginProtocolChoice, parsePluginProtocolChoice,
  type ProtocolChoice, type VideoTestReferences, type VideoTestScenario,
} from './modelProtocolTestRun';
import { useT } from '../../i18n';
import { copyText } from '../../services/clipboardService';
import { isNativeTextProtocolPreset } from '../../services/ai/chatApiProtocol';
import { createSeedanceQuickAdaptTemplate } from '../../services/ai/seedanceModelCapabilities';
import { createH3QuickAdaptTemplate } from '../../services/ai/h3ModelCapabilities';
import { confirmAction } from '../../services/confirmDialog';
import { useAppStore } from '../../store/useAppStore';
import type { InstalledPlugin, PluginModelProtocolReference } from '../../types/plugin';
import { listPluginProtocolPresets, type PluginProtocolPresetEntry } from '../../services/plugins/pluginProtocolPresetService';
import {
  CATEGORY_VARIABLES, MULTIPART_FILE_FIELDS, PRESET_LABELS, createProtocolFormActions, getAvailableChoices, isJsonObject,
  parseDraft, protocolDraftErrors, serializeJson,
} from './modelProtocol/protocolFormMappings';
import { createPreviewVariables, useProtocolTrial } from './modelProtocol/useProtocolTrial';

const EMPTY_PLUGINS: InstalledPlugin[] = [];

type EditorView = 'form' | 'json';
type JsonFieldKind = 'object' | 'value';

interface ModelProtocolEditorProps {
  workflowMode?: boolean;
  readOnlyProtocol?: boolean;
  initialPreviewVariables?: ModelProtocolVariables;
  model: ProviderModelSelection;
  inheritanceLabel?: string;
  catalogId?: string;
  /** 试跑用的真实凭据与网关地址；缺任意一个就只能做本地预览。 */
  apiKey: string;
  baseUrl: string;
  onChange: (profile: ModelExecutionProfile | undefined) => void;
  onImageReferenceRequestModeChange: (mode: ImageReferenceRequestMode | undefined) => void;
  onVideoCapabilityChange?: (capability: VideoModelCapability) => void;
  onValidityChange: (valid: boolean) => void;
  onDraftInvalidChange?: (invalid: boolean) => void;
  testSessionScope?: string;
  onClose: () => void;
}

interface JsonDraftFieldProps {
  fieldId: string;
  label: string;
  value: ProtocolJsonValue | Record<string, string> | undefined;
  kind?: JsonFieldKind;
  rows?: number;
  variables?: readonly string[];
  onChange: (value: ProtocolJsonValue | undefined) => void;
  onValidityChange: (fieldId: string, error?: string) => void;
}

const SUBMIT_TASK_ID_DESCRIPTION = '仅用于轮询请求：提交响应中解析出的任务 ID';

function getVariableTooltip(variable: string): string {
  return getProtocolVariableDescription(variable) ?? '调用时替换为节点中的实际值';
}

const PROTOCOL_JSON_EDITOR_LAYOUT = 'grid min-w-0 grid-cols-[minmax(200px,0.75fr)_minmax(0,1.5fr)] items-stretch gap-3 max-[700px]:grid-cols-1';

function ProtocolVariablePanel({ variables, textareaId, onInsert, t, submitTaskIdVariable }: {
  variables: readonly string[];
  textareaId: string;
  onInsert: (variable: string) => void;
  t: ReturnType<typeof useT>;
  submitTaskIdVariable?: string;
}) {
  return <aside className="provider-protocol-json-variables" aria-label={t('当前模型可用变量')}>
    <div className="provider-protocol-json-guide-title">
      <Icon icon="mdi:code-braces" width="13" />
      <strong>{t('可用变量')}</strong>
      <span>{t('点击插入，悬浮查看说明')}</span>
    </div>
    <p className="m-0 text-xs leading-relaxed text-canvas-text-muted">
      {t('在 JSON 中定位光标，再点击变量插入；选中内容会被替换。')}
    </p>
    <div className="flex max-h-96 flex-wrap items-start gap-1 overflow-y-auto max-[700px]:max-h-48">
      {variables.map((variable) => <button
        key={variable}
        type="button"
        className="ui-chip min-h-5 max-w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canvas-text-muted"
        aria-label={`${t('插入变量')} {{${variable}}}`}
        aria-controls={textareaId}
        data-tooltip={t(variable === submitTaskIdVariable ? SUBMIT_TASK_ID_DESCRIPTION : getVariableTooltip(variable))}
        onMouseDown={(event) => { if (event.button === 0) event.preventDefault(); }}
        onClick={() => onInsert(variable)}
      ><code className="font-mono">{`{{${variable}}}`}</code></button>)}
    </div>
  </aside>;
}

function JsonDraftField({
  fieldId,
  label,
  value,
  kind = 'object',
  rows = 4,
  variables,
  onChange,
  onValidityChange,
}: JsonDraftFieldProps) {
  const t = useT();
  const textareaId = useId();
  const errorId = `${textareaId}-error`;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const selectionRef = useRef<{ start: number; end: number } | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const [draft, setDraft] = useState(() => serializeJson(value));
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    const textarea = textareaRef.current;
    if (caret === null || !textarea) return;
    pendingCaretRef.current = null;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(caret, caret);
    selectionRef.current = { start: caret, end: caret };
  }, [draft]);

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

  const rememberSelection = (textarea: HTMLTextAreaElement) => {
    selectionRef.current = { start: textarea.selectionStart, end: textarea.selectionEnd };
  };
  const insertVariable = (variable: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const selection = selectionRef.current;
    const start = Math.min(selection?.start ?? draft.length, draft.length);
    const end = Math.max(start, Math.min(selection?.end ?? start, draft.length));
    const token = `{{${variable}}}`;
    const nextDraft = draft.slice(0, start) + token + draft.slice(end);
    const caret = start + token.length;
    if (nextDraft === draft) {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(caret, caret);
      selectionRef.current = { start: caret, end: caret };
      return;
    }
    pendingCaretRef.current = caret;
    updateDraft(nextDraft);
  };

  const editor = (
    <label htmlFor={textareaId} className={`provider-protocol-field provider-protocol-json-field${variables ? ' provider-protocol-full-json' : ''}`}>
      <span>{label}</span>
      <textarea
        ref={textareaRef}
        id={textareaId}
        className={variables ? 'flex-auto' : undefined}
        value={draft}
        rows={rows}
        spellCheck={false}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        onFocus={(event) => rememberSelection(event.currentTarget)}
        onSelect={(event) => rememberSelection(event.currentTarget)}
        onBlur={(event) => rememberSelection(event.currentTarget)}
        onChange={(event) => {
          rememberSelection(event.currentTarget);
          updateDraft(event.target.value);
        }}
      />
      {error ? <small id={errorId} role="alert">{t(error)}</small> : null}
    </label>
  );
  return variables ? <div className={PROTOCOL_JSON_EDITOR_LAYOUT}>
    <ProtocolVariablePanel variables={variables} textareaId={textareaId} onInsert={insertVariable} t={t} />
    {editor}
  </div> : editor;
}

export default function ModelProtocolEditor({
  workflowMode = false,
  readOnlyProtocol = false,
  initialPreviewVariables,
  model,
  inheritanceLabel,
  catalogId,
  apiKey,
  baseUrl,
  onChange,
  onImageReferenceRequestModeChange,
  onVideoCapabilityChange,
  onValidityChange,
  onDraftInvalidChange,
  testSessionScope,
  onClose,
}: ModelProtocolEditorProps) {
  const t = useT();
  const simpleEditor = !workflowMode && (model.category === 'image' || model.category === 'text');
  const videoJsonEditor = !workflowMode && model.category === 'video';
  const initialPreset: ProtocolChoice = model.executionProfile?.preset ?? (videoJsonEditor ? 'custom' : 'legacy');
  const initialProtocol = model.executionProfile?.preset === 'custom' && model.executionProfile.protocol
    ? parseModelExecutionProtocol(model.executionProfile.protocol)
    : getDefaultCustomProtocol(model.category);
  const [preset, setPreset] = useState<ProtocolChoice>(initialPreset);
  const [pluginReference, setPluginReference] = useState<PluginModelProtocolReference | undefined>(model.executionProfile?.plugin);
  const plugins = useAppStore((state) => state.installedPlugins ?? EMPTY_PLUGINS);
  const [pluginCatalog, setPluginCatalog] = useState<{ plugins: readonly InstalledPlugin[]; entries: PluginProtocolPresetEntry[] }>();
  useEffect(() => {
    let canceled = false;
    void listPluginProtocolPresets(plugins).then((entries) => { if (!canceled) setPluginCatalog({ plugins, entries }); });
    return () => { canceled = true; };
  }, [plugins]);
  const pluginEntries = pluginCatalog?.plugins === plugins ? pluginCatalog.entries : [];
  const selectedPlugin = pluginEntries.find((entry) => entry.pluginId === pluginReference?.pluginId && entry.presetId === pluginReference?.presetId);
  let selectedPluginKey = 'plugin:missing/missing';
  try { if (pluginReference) selectedPluginKey = pluginProtocolChoice(pluginReference); } catch { /* 损坏引用保留为不可用，由保存与执行校验拒绝。 */ }
  const pluginUnavailable = preset === 'plugin' && !selectedPlugin?.available;
  const [protocol, setProtocol] = useState<NormalizedModelExecutionProtocol>(initialProtocol);
  const [view, setView] = useState<EditorView>(simpleEditor || videoJsonEditor ? 'json' : 'form');
  const [protocolJson, setProtocolJson] = useState(() => serializeJson(initialProtocol));
  const [unsyncedDraft, setUnsyncedDraft] = useState(false);
  const [navigationError, setNavigationError] = useState('');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | null>(() => initialPreset === 'custom'
    ? protocolDraftErrors(initialProtocol, model.category)[0] ?? null : null);
  const [formRevision, setFormRevision] = useState(0);
  const trialVariablesId = useId();
  useEffect(() => { onDraftInvalidChange?.(unsyncedDraft); }, [unsyncedDraft, onDraftInvalidChange]);
  const previewVariablesId = useId();
  const previewVariablesErrorId = `${previewVariablesId}-error`;
  const responseSampleId = useId();
  const responseSampleErrorId = `${responseSampleId}-error`;
  const protocolJsonId = useId();
  const protocolJsonHelpId = `${protocolJsonId}-help`;
  const protocolTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editorRef = useRef<HTMLElement | null>(null);
  const protocolSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const pendingProtocolCaretRef = useRef<number | null>(null);
  const invalidFormFieldsRef = useRef(new Set<string>());
  const {
    previewVariablesJson, setPreviewVariablesJson, testVariablesJson, setTestVariablesJson,
    setTestScenario, klingVideoContract, klingFrameMode, activeTestScenario, supportsTestKeyframes, testReferences, setTestReferences, session, responseSampleJson,
    setResponseSampleJson, testRun, previewState, supportsStructuredResponse, responsePreviewState,
    runProtocolTest, resumeProtocolTest, cancelProtocolTest, trialRunning, sessionMessage,
    testRunDisabledReason, discardTrial, resetTrialForTemplate,
  } = useProtocolTrial({
    model, catalogId, initialPreviewVariables, workflowMode, testSessionScope, apiKey, baseUrl, preset,
    protocol, protocolJson, error, invalidFormFieldsRef, pluginReference, pluginUnavailable, t,
  });
  useEffect(() => {
    onValidityChange(!error && invalidFormFieldsRef.current.size === 0);
  }, [error, onValidityChange]);
  useLayoutEffect(() => {
    const caret = pendingProtocolCaretRef.current;
    const textarea = protocolTextareaRef.current;
    if (caret === null || !textarea) return;
    pendingProtocolCaretRef.current = null;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(caret, caret);
    protocolSelectionRef.current = { start: caret, end: caret };
  }, [protocolJson]);

  const publishProtocol = (nextProtocol: NormalizedModelExecutionProtocol) => {
    setProtocol(nextProtocol);
    setProtocolJson(serializeJson(nextProtocol));
    const errors = protocolDraftErrors(nextProtocol, model.category);
    setError(errors[0] ?? (invalidFormFieldsRef.current.size > 0 ? '请修正表单中的 JSON 错误' : null));
    const valid = errors.length === 0 && invalidFormFieldsRef.current.size === 0;
    setUnsyncedDraft(!valid);
    setNavigationError('');
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
    setUnsyncedDraft(invalidFormFieldsRef.current.size > 0 || protocolDraftErrors(protocol, model.category).length > 0);
    setNavigationError('');
    const protocolErrors = protocolDraftErrors(protocol, model.category);
    setError(protocolErrors[0] ?? (invalidFormFieldsRef.current.size > 0 ? '请修正表单中的 JSON 错误' : null));
    onValidityChange(protocolErrors.length === 0 && invalidFormFieldsRef.current.size === 0);
  };

  const updateCustomJson = (value: string) => {
    setProtocolJson(value);
    const parsed = parseDraft(value);
    const draftError = parsed.error ?? (parsed.protocol ? protocolDraftErrors(parsed.protocol, model.category)[0] : undefined);
    setUnsyncedDraft(!!draftError);
    setNavigationError('');
    setError(draftError ?? null);
    onValidityChange(!!parsed.protocol && !draftError);
    if (parsed.protocol) {
      invalidFormFieldsRef.current.clear();
      setProtocol(parsed.protocol);
      if (!draftError) onChange({ preset: 'custom', protocol: parsed.protocol });
    }
  };

  const rememberProtocolSelection = (textarea: HTMLTextAreaElement) => {
    protocolSelectionRef.current = { start: textarea.selectionStart, end: textarea.selectionEnd };
  };

  const insertProtocolVariable = (variable: string) => {
    const textarea = protocolTextareaRef.current;
    if (!textarea) return;
    const selection = protocolSelectionRef.current;
    const start = Math.min(selection?.start ?? protocolJson.length, protocolJson.length);
    const end = Math.max(start, Math.min(selection?.end ?? start, protocolJson.length));
    const token = `{{${variable}}}`;
    const nextValue = protocolJson.slice(0, start) + token + protocolJson.slice(end);
    const caret = start + token.length;
    if (nextValue === protocolJson) {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(caret, caret);
      protocolSelectionRef.current = { start: caret, end: caret };
      return;
    }
    pendingProtocolCaretRef.current = caret;
    updateCustomJson(nextValue);
  };

  const changeView = (nextView: EditorView) => {
    if (view === nextView) return;
    if (unsyncedDraft || invalidFormFieldsRef.current.size > 0) {
      setNavigationError(t('请先修正当前草稿再切换视图，未完成的内容已保留。'));
      if (view === 'json') protocolTextareaRef.current?.focus({ preventScroll: true });
      else editorRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus({ preventScroll: true });
      return;
    }
    protocolSelectionRef.current = null;
    pendingProtocolCaretRef.current = null;
    invalidFormFieldsRef.current.clear();
    const errors = protocolDraftErrors(protocol, model.category);
    setError(errors[0] ?? null);
    setProtocolJson(serializeJson(protocol));
    setView(nextView);
    onValidityChange(errors.length === 0);
  };

  const allowOverwriteDraft = async () => !unsyncedDraft || await confirmAction(
    t('当前协议有尚未同步的草稿，放弃后将丢失这些内容。'),
    { title: t('放弃未完成的协议草稿？'), okLabel: t('放弃草稿'), cancelLabel: t('继续编辑') },
  ).catch(() => false);

  const allowFormTransform = () => {
    if (!invalidFormFieldsRef.current.size && !(view === 'json' && unsyncedDraft)) return true;
    setNavigationError(t('请先修正当前草稿再切换视图，未完成的内容已保留。'));
    editorRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus({ preventScroll: true });
    return false;
  };

  const changePreset = async (choice: string) => {
    const reference = parsePluginProtocolChoice(choice);
    const nextPreset = reference ? 'plugin' : choice as ProtocolChoice;
    if ((nextPreset === preset && (nextPreset !== 'plugin' || choice === selectedPluginKey)) || !(await allowOverwriteDraft())) return;
    setUnsyncedDraft(false);
    setNavigationError('');
    protocolSelectionRef.current = null;
    pendingProtocolCaretRef.current = null;
    setPreset(nextPreset);
    setError(null);
    invalidFormFieldsRef.current.clear();
    if (reference) {
      setPluginReference(reference);
      onValidityChange(true);
      onChange({ preset: 'plugin', plugin: reference });
      return;
    }
    if (nextPreset === 'legacy') {
      onValidityChange(true);
      onChange(undefined);
      return;
    }
    if (nextPreset === 'custom') {
      if (simpleEditor || videoJsonEditor) setView('json');
      const nextProtocol = preset !== 'legacy' && preset !== 'custom'
        && preset !== 'plugin' && !isNativeTextProtocolPreset(preset)
        ? getModelProtocolPreset(preset)
        : protocol;
      publishProtocol(nextProtocol);
      return;
    }
    if (isNativeTextProtocolPreset(nextPreset)) {
      onValidityChange(true);
      onChange({ preset: nextPreset });
      return;
    }
    if (nextPreset === 'plugin') return;
    const nextProtocol = getModelProtocolPreset(nextPreset);
    setProtocol(nextProtocol);
    setProtocolJson(serializeJson(nextProtocol));
    onValidityChange(true);
    if (model.category === 'image' && nextPreset === 'openai-gpt-image') {
      onImageReferenceRequestModeChange('edits-multipart');
    } else if (model.category === 'image' && (nextPreset === 'gpt-image-gateway-json'
      || nextPreset === 'google-image-native' || nextPreset === 'xai-image-native')) {
      onImageReferenceRequestModeChange(undefined);
    }
    onChange({ preset: nextPreset });
  };

  const applyVideoJsonTemplate = async (templateId: 'sd2.0' | 'sd2.5' | 'h3') => {
    if (!(await allowOverwriteDraft())) return;
    setUnsyncedDraft(false);
    setNavigationError('');
    const template = templateId === 'h3'
      ? createH3QuickAdaptTemplate('h3-standard', 'apimart')
      : createSeedanceQuickAdaptTemplate(templateId === 'sd2.0' ? '2.0-standard' : '2.5', 'apimart');
    resetTrialForTemplate();
    protocolSelectionRef.current = null;
    pendingProtocolCaretRef.current = null;
    invalidFormFieldsRef.current.clear();
    setFormRevision((revision) => revision + 1);
    setPreset('custom');
    setView('json');
    onVideoCapabilityChange?.(template.capability);
    const nextModel = { ...model, videoCapability: template.capability };
    setTestVariablesJson(serializeJson(createPreviewVariables(nextModel)));
    setPreviewVariablesJson(serializeJson(createPreviewVariables(nextModel)));
    setTestScenario(defaultVideoTestScenario(nextModel));
    publishProtocol(parseModelExecutionProtocol(template.executionProfile.protocol!));
  };

  const formActions = () => createProtocolFormActions({ model, allowFormTransform, updateProtocol, setFormRevision });

  const auth = protocol.auth ?? { type: 'bearer' as const };
  const availableVariables = workflowMode && initialPreviewVariables
    ? Object.keys(initialPreviewVariables)
    : CATEGORY_VARIABLES[model.category];
  const poll = protocol.poll;
  const responseResult = protocol.response.result ?? {};
  const pollResponse = poll?.response;
  const pollResult = pollResponse?.result;
  const submitTaskIdVariable = `submit.${protocol.response.taskIdPath ?? 'task_id'}`;
  const pollRetry = {
    ...getDefaultModelProtocolPollRetryConfig(),
    ...poll?.retry,
  };
  const showReferenceRequest = model.category === 'image' && !workflowMode
    && (preset === 'openai-image' || preset === 'legacy');
  const fileFields = !workflowMode && (model.category === 'image' || model.category === 'video')
    ? MULTIPART_FILE_FIELDS[model.category] : undefined;

  return (
    <section ref={editorRef} className="provider-protocol-editor is-small" aria-label={t('{name} 调用协议', { name: model.name })}>
      <div className="provider-protocol-editor-head">
        <div>
          <span>{t(workflowMode ? '工作流调用协议' : '模型调用协议')}</span>
          <strong>{model.name}</strong>
        </div>
        <PopupCloseButton ariaLabel={t('关闭协议设置')} onClick={onClose} />
      </div>

      {!readOnlyProtocol && <div className={`provider-protocol-topbar ${showReferenceRequest ? 'has-reference-mode' : ''}`}>
        <label className="provider-protocol-field">
          <span>{t('协议预设')}</span>
          <Select fixedMenu value={preset === 'plugin' ? selectedPluginKey : preset} onChange={changePreset}>
            {(workflowMode ? ['custom' as const] : getAvailableChoices(model.category, preset)).map((choice) => (
              <option key={choice} value={choice}>{choice === 'legacy' && inheritanceLabel
                ? t(inheritanceLabel) : t(PRESET_LABELS[choice])}</option>
            ))}
            {!workflowMode && model.category === 'text' && pluginEntries.map((entry) => (
              <option key={pluginProtocolChoice(entry)} value={pluginProtocolChoice(entry)} disabled={!entry.available}>
                {entry.name} · {t('插件')} {entry.pluginName} ({entry.pluginId}/{entry.presetId}){entry.available ? '' : ` · ${t('不可用')}`}
              </option>
            ))}
            {preset === 'plugin' && !selectedPlugin && <option value={selectedPluginKey} disabled>{t('插件预设不可用')} ({pluginReference?.pluginId}/{pluginReference?.presetId})</option>}
          </Select>
        </label>
        {showReferenceRequest ? (
          <label className="provider-protocol-field">
            <span>{t('参考图请求')}</span>
            <Select fixedMenu
              value={model.imageReferenceRequestMode ?? 'generation-json-image-urls'}
              onChange={(selectedOptionValue) => onImageReferenceRequestModeChange(
                selectedOptionValue as ImageReferenceRequestMode,
              )}
            >
              <option value="generation-json-image-urls">{t('生成接口 JSON（image_urls）')}</option>
              <option value="generation-json-image-data-urls">{t('生成接口 JSON（image，data URL 数组）')}</option>
              <option value="edits-multipart">{t('编辑接口 Multipart（图片文件）')}</option>
            </Select>
          </label>
        ) : null}
        {preset === 'custom' && !simpleEditor ? (
          <div className="provider-protocol-view-tabs" role="tablist" aria-label={t('协议编辑方式')}>
            <button type="button" role="tab" aria-selected={view === 'form'} className={view === 'form' ? 'is-active' : ''} onClick={() => changeView('form')}>
              {t('表单')}
            </button>
            <button type="button" role="tab" aria-selected={view === 'json'} className={view === 'json' ? 'is-active' : ''} onClick={() => changeView('json')}>
              JSON
            </button>
          </div>
        ) : null}
      </div>}

      {preset === 'plugin' && <p role="status" className="text-xs text-canvas-text-secondary">
        {selectedPlugin?.available ? t('协议由宿主适配器执行，凭据由连接注入。') : t(selectedPlugin?.reason ?? '协议插件未就绪，请检查插件设置中的健康状态。')}
      </p>}

      {preset === 'custom' && !readOnlyProtocol ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-canvas-text-secondary">
          <span>{t('按文档配置 → 预览请求与响应 → 试跑验证')}</span>
          {fileFields && <label className="provider-protocol-field">
            <span>{t('插入文件字段')} (Multipart)</span>
            <Select fixedMenu value="" aria-label={t('插入文件字段')}
              disabled={unsyncedDraft || (protocol.submit.body !== undefined && !isJsonObject(protocol.submit.body))}
              onChange={(field) => {
                if (Object.hasOwn(fileFields, field)) formActions().insertMultipartFile(field, fileFields[field]);
              }}>
              <option value="">{t('选择字段')}</option>
              {Object.entries(fileFields).map(([field, variable]) => (
                <option key={field} value={field}>{field}: {variable}</option>
              ))}
            </Select>
          </label>}
          <div className="flex items-center gap-2">
            <span role="status" className="text-xs text-canvas-text-secondary">
              {copyStatus === 'success' ? t('已复制') : copyStatus === 'error' ? t('复制失败，请重试') : ''}
            </span>
            <button
              type="button"
              className="ui-btn ui-btn--sm"
              disabled={copyStatus === 'copying'}
              onClick={async () => {
                setCopyStatus('copying');
                const instructions = [
                  '请根据我随后提供的需求和厂商 API 文档，修改下面的 AI Canvas 声明式调用协议。',
                  `模型：${model.name}；类别：${model.category}`,
                  '',
                  '## 修改要求',
                  '- 返回完整、可直接替换的 JSON，并简要说明修改原因。',
                  '- 不要编造接口路径、参考素材字段、模型能力或响应结构；信息不足时指出缺少的文档。',
                  '- 保留与需求无关的现有配置；不要把 API Key、令牌或本地文件路径写入 JSON。鉴权由应用注入。',
                  '- 仅使用下列当前类别可用的变量；保留双花括号模板，不要替换成示例值。',
                  '- 多参考素材的 $forEach 仅用于 JSON body 数组元素，格式为 {"$forEach":"{{referenceImageUrls}}","$value":{"image_url":{"url":"{{referenceImageUrls}}"}}}；字段形状必须以厂商文档为准。根变量仅允许 referenceImageUrls/referenceVideoUrls/referenceAudioUrls，并且必须属于下列可用变量。',
                  '- 可选数组元素使用 {"$whenPresent":"{{imageUrls.0}}","$value":{...}}；条件必须是完整变量模板，禁止表达式或动态键。',
                  ...(fileFields ? ['- 接口要求随请求上传参考文件时，submit.bodyEncoding 选 multipart。请求体文件字段使用 {"$file":"{{变量}}"}，数组变量按顺序重复同名文件字段，字段名按厂商文档填写。'] : []),
                  `- 异步任务通过 response.taskIdPath 提取任务 ID，在 poll 中使用 {{${submitTaskIdVariable}}}，不要写死任务编号。`,
                  `- 异步完成后另行读取二进制时，在 poll.response.result 中配置 download: {"method":"GET","path":"/按厂商文档填写/{{${submitTaskIdVariable}}}/content"} 和 mimeType；不能同时配置 urlPath/textPath/base64Path/fetchUrl。`,
                  '',
                  '## 可用参数与变量说明',
                  '变量可用于 path、query、headers 或 body，调用时替换为节点中的实际值。',
                  ...availableVariables.map((variable) => `- {{${variable}}}：${getVariableTooltip(variable)}`),
                  `- {{${submitTaskIdVariable}}}：${SUBMIT_TASK_ID_DESCRIPTION}`,
                  '',
                  '## 配置说明',
                  'version 固定为 2；mode 为 sync 或 async。auth 配置 type、name、prefix，密钥由连接注入。',
                  'submit 配置同源请求的 method、path、pathMode、query、headers、bodyEncoding 和 body。',
                  'response 配置首次响应：同步从 result 取结果，异步从 taskIdPath 取任务 ID。',
                  'poll 配置任务查询、成功/失败状态、结果、查询间隔与重试；生成提交和结果下载不自动重试。',
                  'download 仅允许 method、path、pathMode、headers、query；method 固定 GET，path/query 必须引用本次提交任务 ID。',
                  '响应路径支持 data.0.url、data.*.url；仅使用受信变量，禁止脚本或表达式。',
                  '',
                  '## 当前 JSON 草稿（可能尚未通过校验，请检查）',
                  '```json',
                  protocolJson,
                  '```',
                ].join('\n');
                const safeText = apiKey ? instructions.split(apiKey).join('[REDACTED]') : instructions;
                setCopyStatus(await copyText(safeText) ? 'success' : 'error');
              }}
            >
              <Icon icon="lucide:copy" width="14" />
              {t('复制给AI修改')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="provider-protocol-testrun" aria-live="polite">
        {navigationError ? <p role="alert" className="ui-alert ui-alert--warning mb-2">{navigationError}</p> : null}
        <details className="mb-2 rounded-md border border-canvas-border p-2">
          <summary className="cursor-pointer text-xs text-canvas-text-secondary">{t('真实试跑配置')}</summary>
          <p className="my-2 text-xs text-canvas-text-muted">{t('试跑变量与本地预览分开；只有点击试跑才会发送真实请求。')}</p>
          {!workflowMode && model.category === 'video' ? <div className="mb-2 grid gap-2 sm:grid-cols-2">
            {!klingVideoContract ? <label className="ui-field sm:col-span-2"><span className="ui-label">{t('试跑场景')}</span>
              <Select fixedMenu disabled={trialRunning} value={activeTestScenario} onChange={(value) => setTestScenario(value as VideoTestScenario)}>
                <option value="text">{t('文生视频（无参考素材）')}</option>
                {supportsTestKeyframes ? <option value="keyframe">{t('首尾帧（不混用参考素材）')}</option> : null}
                <option value="reference">{t('多参考素材（不使用首尾帧）')}</option>
              </Select>
            </label> : null}
            {!klingVideoContract ? <p className="m-0 text-xs text-canvas-text-muted sm:col-span-2">{t('视频素材由上方场景填写，JSON 只调整参数；未声明的参数可留空。')}</p> : null}
            {(activeTestScenario === 'keyframe'
              ? [['firstImage', '首帧图片地址'], ...(klingFrameMode === 'keyframes'
                ? [['images', '中间帧地址（每行一条，可选）']] : []), ...(klingFrameMode !== 'single' ? [['lastImage', '尾帧图片地址（可选）']] : [])]
              : activeTestScenario === 'reference' ? [['images', '参考图片地址（每行一条）'], ['videos', '参考视频地址（每行一条）'], ['audios', '参考音频地址（每行一条）']] : []
            ).map(([field, label]) => <label key={field} className="ui-field min-w-0">
              <span className="ui-label">{t(label)}</span>
              <textarea className="ui-textarea" rows={2} value={testReferences[field as keyof VideoTestReferences]}
                disabled={trialRunning} spellCheck={false} autoCorrect="off" autoCapitalize="none"
                onChange={(event) => setTestReferences((current) => ({ ...current, [field]: event.target.value }))} />
            </label>)}
          </div> : null}
          <label className="ui-field" htmlFor={trialVariablesId}><span className="ui-label">{t('试跑参数 JSON')}</span>
            <textarea id={trialVariablesId} className="ui-textarea font-mono" rows={6} spellCheck={false}
              value={testVariablesJson} disabled={trialRunning} onChange={(event) => setTestVariablesJson(event.target.value)} />
          </label>
        </details>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="provider-secondary-btn h-7"
            disabled={!!testRunDisabledReason || trialRunning || !!session}
            title={testRunDisabledReason || undefined}
            onClick={() => void runProtocolTest()}
          >
            <Icon
              icon={trialRunning ? 'mdi:loading' : 'mdi:play-circle-outline'}
              className={trialRunning ? 'settings-spin' : undefined}
              width="14"
            />
            {trialRunning ? t('试跑中') : t('试跑')}
          </button>
          {trialRunning ? (
            <button type="button" className="provider-text-btn h-7" onClick={cancelProtocolTest}>
              {t(session?.status === 'polling' ? '暂停查询' : '停止等待')}
            </button>
          ) : null}
          {session?.canResume ? <button type="button" className="ui-btn ui-btn--sm" disabled={!apiKey.trim()}
            onClick={() => void resumeProtocolTest()}>{t('继续查询')}</button> : null}
          {session && !trialRunning ? <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => {
            void confirmAction(t('放弃查询记录不会停止上游任务；再次试跑会创建新任务并可能计费。'),
              { title: t('放弃试跑记录？'), okLabel: t('放弃记录'), cancelLabel: t('保留任务') }).then((confirmed) => {
              if (confirmed) discardTrial();
            }).catch(() => {});
          }}>{t('放弃记录')}</button> : null}
          <small className="text-[11px] text-canvas-text-muted">
            {testRunDisabledReason
              || t('使用试跑配置发送真实请求，会产生调用与计费')}
          </small>
        </div>
        {sessionMessage ? <p role="status" className="mt-2 text-xs text-canvas-text-secondary">{sessionMessage}</p> : null}
        {session?.taskId ? <p className="mt-1 break-all text-xs text-canvas-text-muted">{t('任务 ID {id}', { id: session.taskId })}</p> : null}
        {session ? <p className="mt-1 text-xs text-canvas-text-muted">{t('查询记录仅保留到应用关闭或刷新。')}</p> : null}
        {testRun.message ? (
          <div role={testRun.status === 'error' ? 'alert' : 'status'}
            className={`provider-catalog-message is-${testRun.status === 'error' ? 'error' : 'ready'} mt-2`}>
            <Icon
              icon={testRun.status === 'error' ? 'mdi:alert-circle-outline' : 'mdi:check-circle-outline'}
              width="14"
            />
            <span className="break-all">{testRun.message}</span>
          </div>
        ) : null}
        {testRun.detail ? (
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-canvas-border bg-canvas-bg/40 p-2.5 font-mono text-[12px] leading-relaxed text-canvas-text-secondary">
            {testRun.detail}
          </pre>
        ) : null}
      </div>

      {preset === 'custom' && !readOnlyProtocol && !simpleEditor && view === 'form' ? (
        <div className="provider-protocol-form">
          <section className="provider-protocol-form-section">
            <div className="provider-protocol-section-title">
              <Icon icon="mdi:shield-key-outline" width="14" />
              <span>{t('协议与鉴权')}</span>
            </div>
            <div className="provider-protocol-grid is-three">
              <label className="provider-protocol-field">
                <span>{t('执行模式')}</span>
                <Select fixedMenu value={protocol.mode} onChange={(selectedOptionValue) => formActions().changeMode(selectedOptionValue as ModelExecutionProtocol['mode'])}>
                  <option value="sync">{t('同步返回')}</option>
                  <option value="async">{t('异步轮询')}</option>
                </Select>
              </label>
              <label className="provider-protocol-field">
                <span>{t('鉴权方式')}</span>
                <Select fixedMenu value={auth.type} onChange={(selectedOptionValue) => formActions().changeAuthType(selectedOptionValue as ModelProtocolAuthType)}>
                  <option value="bearer">Bearer</option>
                  <option value="header">{t('自定义 Header')}</option>
                  <option value="query">{t('Query 参数')}</option>
                  <option value="none">{t('无需鉴权')}</option>
                </Select>
              </label>
              {auth.type === 'header' || auth.type === 'query' ? (
                <label className="provider-protocol-field">
                  <span>{auth.type === 'header' ? t('Header 名称') : t('Query 名称')}</span>
                  <input
                    value={auth.name ?? ''}
                    onChange={(event) => updateProtocol((draft) => {
                      draft.auth = { ...auth, name: event.target.value };
                    })}
                  />
                </label>
              ) : (
                <label className="provider-protocol-field">
                  <span>{t('密钥前缀')}</span>
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
                <span>{t('密钥前缀')}</span>
                <input
                  value={auth.prefix ?? ''}
                  placeholder={t('可选')}
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
                <span>{t('OpenAI SSE 对话兼容')}</span>
              </label>
            ) : null}
          </section>

          <section className="provider-protocol-form-section">
            <div className="provider-protocol-section-title">
              <Icon icon="mdi:send-outline" width="14" />
              <span>{t('提交请求')}</span>
            </div>
            <div className="provider-protocol-grid is-request">
              <label className="provider-protocol-field">
                <span>{t('方法')}</span>
                <Select fixedMenu value={protocol.submit.method} onChange={(selectedOptionValue) => formActions().updateSubmit({ method: selectedOptionValue as 'GET' | 'POST' })}>
                  <option value="POST">POST</option>
                  <option value="GET">GET</option>
                </Select>
              </label>
              <label className="provider-protocol-field">
                <span>{t('路径')}</span>
                <input value={protocol.submit.path} onChange={(event) => formActions().updateSubmit({ path: event.target.value })} />
              </label>
              <label className="provider-protocol-field">
                <span>{t('路径基准')}</span>
                <Select fixedMenu value={protocol.submit.pathMode ?? 'append'} onChange={(selectedOptionValue) => formActions().updateSubmit({ pathMode: selectedOptionValue as 'append' | 'origin' })}>
                  <option value="append">{t('连接地址')}</option>
                  <option value="origin">{t('域名根路径')}</option>
                </Select>
              </label>
            </div>
            <div className="provider-protocol-grid">
              <label className="provider-protocol-field">
                <span>{t('请求体编码')}</span>
                <Select fixedMenu
                  value={protocol.submit.bodyEncoding ?? 'json'}
                  onChange={(selectedOptionValue) => formActions().updateSubmit({
                    bodyEncoding: selectedOptionValue as ModelProtocolBodyEncoding,
                  })}
                >
                  <option value="json">JSON</option>
                  <option value="form-urlencoded">Form URL Encoded</option>
                  <option value="multipart">Multipart Form Data</option>
                </Select>
              </label>
              {model.category === 'image' || model.category === 'video' ? (
                <label className="provider-protocol-field provider-protocol-size-insert">
                  <span>{t('插入尺寸字段')}</span>
                  <Select fixedMenu value="" onChange={(selectedOptionValue) => formActions().insertSizeMapping(selectedOptionValue)}>
                    <option value="">{t('选择映射')}</option>
                    <option value="size">size: widthxheight</option>
                    <option value="dimensions">width + height</option>
                    {model.category === 'image' ? <option value="image-semantic">resolution + aspect_ratio</option> : null}
                    {model.category === 'video' ? <option value="video-standard">resolution + num_frames + frame_rate</option> : null}
                    {model.category === 'video' ? <option value="seedance">Seedance resolution + ratio + duration</option> : null}
                    {model.category === 'video' ? <option value="seedance-openai">Seedance resolution + aspect_ratio + duration</option> : null}
                  </Select>
                </label>
              ) : null}
              {workflowMode && model.category === 'image' && protocol.submit.bodyEncoding === 'multipart' ? (
                <label className="provider-protocol-field">
                  <span>{t('插入文件字段')}</span>
                  <Select fixedMenu value="" onChange={(selectedOptionValue) => formActions().insertMultipartFile(selectedOptionValue)}>
                    <option value="">{t('选择字段')}</option>
                    <option value="image">image: imageUrls.0</option>
                    <option value="file">file: imageUrls.0</option>
                    <option value="reference_image">reference_image: imageUrls.0</option>
                  </Select>
                </label>
              ) : null}
              {model.category === 'image' && protocol.submit.bodyEncoding !== 'multipart' ? (
                <label className="provider-protocol-field">
                  <span>{t('插入参考图字段')}</span>
                  <Select fixedMenu value="" onChange={(selectedOptionValue) => formActions().insertJsonReferenceArray(selectedOptionValue)}>
                    <option value="">{t('选择字段')}</option>
                    <option value="image">image: imageUrls</option>
                    <option value="image_urls">image_urls: imageUrls</option>
                  </Select>
                </label>
              ) : null}
              {model.category === 'video' && protocol.submit.bodyEncoding !== 'multipart' ? (
                <label className="provider-protocol-field">
                  <span>{t('插入参考素材字段')}</span>
                  <Select fixedMenu value="" onChange={(selectedOptionValue) => formActions().insertVideoReferenceField(selectedOptionValue)}>
                    <option value="">{t('选择字段')}</option>
                    <option value="image_urls">image_urls</option>
                    <option value="first_image">first_image</option>
                    <option value="last_image">last_image</option>
                    <option value="reference_image_urls">reference_image_urls</option>
                    <option value="video_urls">video_urls</option>
                    <option value="reference_video_url">reference_video_url</option>
                    <option value="reference_video_urls">reference_video_urls</option>
                    <option value="audio_urls">audio_urls</option>
                    <option value="audio_url">audio_url</option>
                    <option value="reference_audio_urls">reference_audio_urls</option>
                  </Select>
                </label>
              ) : null}
            </div>
            <div className="provider-protocol-json-grid">
              <JsonDraftField
                fieldId="submit-headers"
                label={t('请求头 JSON')}
                value={protocol.submit.headers}
                rows={4}
                onValidityChange={updateFormValidity}
                onChange={(value) => formActions().updateSubmit({ headers: value as Record<string, string> })}
              />
              <JsonDraftField
                fieldId="submit-query"
                label={t('Query JSON')}
                value={protocol.submit.query}
                rows={4}
                onValidityChange={updateFormValidity}
                onChange={(value) => formActions().updateSubmit({ query: value as Record<string, ProtocolJsonValue> })}
              />
            </div>
            <JsonDraftField
              key={`submit-body-${formRevision}`}
              fieldId="submit-body"
              label={t('请求体 JSON')}
              value={protocol.submit.body}
              kind="value"
              rows={16}
              variables={availableVariables}
              onValidityChange={updateFormValidity}
              onChange={(value) => formActions().updateSubmit({ body: value })}
            />
          </section>

          <section className="provider-protocol-form-section">
            <div className="provider-protocol-section-title">
              <Icon icon="mdi:code-json" width="14" />
              <span>{protocol.mode === 'sync' ? t('返回值结构') : t('任务与返回值结构')}</span>
            </div>
            {protocol.mode === 'sync' ? (
              <>
                <div className="provider-protocol-grid is-three">
                  <label className="provider-protocol-field">
                    <span>{t('响应类型')}</span>
                    <Select fixedMenu
                      value={protocol.response.type}
                      onChange={(selectedOptionValue) => formActions().changeResponseType(selectedOptionValue as ModelProtocolResponseType)}
                    >
                      <option value="json">JSON</option>
                      <option value="text">{t('原始文本')}</option>
                      <option value="binary">{t('原始二进制')}</option>
                    </Select>
                  </label>
                  {protocol.response.type === 'binary' ? (
                    <label className="provider-protocol-field">
                      <span>{t('备用 MIME 类型')}</span>
                      <input
                        value={responseResult.mimeType ?? ''}
                        placeholder={model.category === 'video' ? 'video/mp4' : model.category === 'audio' ? 'audio/mpeg' : 'image/png'}
                        onChange={(event) => formActions().updateResponseResult({ mimeType: event.target.value || undefined })}
                      />
                    </label>
                  ) : null}
                  <label className="provider-protocol-field">
                    <span>{t('错误路径')}</span>
                    <input
                      value={protocol.response.errorPath ?? ''}
                      onChange={(event) => formActions().updateResponse({ errorPath: event.target.value || undefined })}
                    />
                  </label>
                </div>
                {protocol.response.type === 'json' ? (
                  <div className="provider-protocol-grid is-three">
                    <label className="provider-protocol-field">
                      <span>{t('URL 结果路径')}</span>
                      <input
                        value={responseResult.urlPath ?? ''}
                        onChange={(event) => formActions().updateResponseResult({ urlPath: event.target.value || undefined })}
                      />
                    </label>
                    <label className="provider-protocol-field">
                      <span>{t('文本结果路径')}</span>
                      <input
                        value={responseResult.textPath ?? ''}
                        onChange={(event) => formActions().updateResponseResult({ textPath: event.target.value || undefined })}
                      />
                    </label>
                    <label className="provider-protocol-field">
                      <span>{t('Base64 结果路径')}</span>
                      <input
                        value={responseResult.base64Path ?? ''}
                        onChange={(event) => formActions().updateResponseResult({ base64Path: event.target.value || undefined })}
                      />
                    </label>
                    {responseResult.base64Path ? (
                      <label className="provider-protocol-field">
                        <span>{t('Base64 MIME 类型')}</span>
                        <input
                          value={responseResult.mimeType ?? ''}
                          placeholder={model.category === 'video' ? 'video/mp4' : model.category === 'audio' ? 'audio/mpeg' : 'image/png'}
                          onChange={(event) => formActions().updateResponseResult({ mimeType: event.target.value || undefined })}
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
                    <span>{t('任务 ID 路径')}</span>
                    <input
                      value={protocol.response.taskIdPath ?? ''}
                      onChange={(event) => formActions().updateResponse({ taskIdPath: event.target.value })}
                    />
                  </label>
                  <label className="provider-protocol-field">
                    <span>{t('轮询方法')}</span>
                    <Select fixedMenu value={poll.method} onChange={(selectedOptionValue) => formActions().updatePoll({ method: selectedOptionValue as 'GET' | 'POST' })}>
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                    </Select>
                  </label>
                  <label className="provider-protocol-field">
                    <span>{t('轮询间隔 ms')}</span>
                    <input type="number" min={1000} max={60000} value={poll.intervalMs ?? 3000} onChange={(event) => formActions().updatePoll({ intervalMs: Number(event.target.value) })} />
                  </label>
                  <label className="provider-protocol-field">
                    <span>{t('轮询请求体编码')}</span>
                    <Select fixedMenu
                      value={poll.bodyEncoding ?? 'json'}
                      onChange={(selectedOptionValue) => formActions().updatePoll({
                        bodyEncoding: selectedOptionValue as Exclude<ModelProtocolBodyEncoding, 'multipart'>,
                      })}
                    >
                      <option value="json">JSON</option>
                      <option value="form-urlencoded">Form URL Encoded</option>
                    </Select>
                  </label>
                </div>
                <div className="provider-protocol-grid is-request">
                  <label className="provider-protocol-field provider-protocol-path-field">
                    <span>{t('轮询路径')}</span>
                    <input value={poll.path} onChange={(event) => formActions().updatePoll({ path: event.target.value })} />
                  </label>
                  <label className="provider-protocol-field">
                    <span>{t('路径基准')}</span>
                    <Select fixedMenu value={poll.pathMode ?? 'append'} onChange={(selectedOptionValue) => formActions().updatePoll({ pathMode: selectedOptionValue as 'append' | 'origin' })}>
                      <option value="append">{t('连接地址')}</option>
                      <option value="origin">{t('域名根路径')}</option>
                    </Select>
                  </label>
                </div>
                <div className="provider-protocol-json-grid">
                  <JsonDraftField
                    fieldId="poll-headers"
                    label={t('轮询请求头 JSON')}
                    value={poll.headers}
                    rows={4}
                    onValidityChange={updateFormValidity}
                    onChange={(value) => formActions().updatePoll({ headers: value as Record<string, string> })}
                  />
                  <JsonDraftField
                    fieldId="poll-query"
                    label={t('轮询 Query JSON')}
                    value={poll.query}
                    rows={4}
                    onValidityChange={updateFormValidity}
                    onChange={(value) => formActions().updatePoll({ query: value as Record<string, ProtocolJsonValue> })}
                  />
                </div>
                <JsonDraftField
                  fieldId="poll-body"
                  label={t('轮询请求体 JSON')}
                  value={poll.body}
                  kind="value"
                  rows={5}
                  onValidityChange={updateFormValidity}
                  onChange={(value) => formActions().updatePoll({ body: value })}
                />
                <div className="provider-protocol-grid is-three">
                  <label className="provider-protocol-field">
                    <span>{t('状态路径')}</span>
                    <input value={pollResponse?.statusPath ?? ''} onChange={(event) => formActions().updatePollResponse({ statusPath: event.target.value })} />
                  </label>
                  <label className="provider-protocol-field">
                    <span>{t('成功状态')}</span>
                    <input value={pollResponse?.successValues.join(', ') ?? ''} onChange={(event) => formActions().updatePollResponse({ successValues: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} />
                  </label>
                  <label className="provider-protocol-field">
                    <span>{t('失败状态')}</span>
                    <input value={pollResponse?.failureValues.join(', ') ?? ''} onChange={(event) => formActions().updatePollResponse({ failureValues: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} />
                  </label>
                </div>
                <label className="provider-protocol-field">
                  <span>{t('结果获取方式')}</span>
                  <Select fixedMenu value={pollResult?.download ? 'download' : 'response'} onChange={(value) => {
                    const mimeType = pollResult?.mimeType;
                    formActions().updatePollResponse({ result: value === 'download'
                      ? { mimeType, download: { method: 'GET', path: '' } }
                      : { mimeType, urlPath: 'url' } });
                  }}>
                    <option value="response">{t('从响应字段读取')}</option>
                    <option value="download">{t('完成后同源下载')}</option>
                  </Select>
                </label>
                {pollResult?.download ? (
                  <>
                    <div className="provider-protocol-grid is-request">
                      <label className="provider-protocol-field provider-protocol-path-field">
                        <span>{t('结果下载路径（GET）')}</span>
                        <input value={pollResult.download.path} placeholder={t('按接口文档填写，包含本次任务 ID 变量')}
                          onChange={(event) => formActions().updatePollResult({ download: { ...pollResult.download!, path: event.target.value } })} />
                      </label>
                      <label className="provider-protocol-field">
                        <span>{t('路径基准')}</span>
                        <Select fixedMenu value={pollResult.download.pathMode ?? 'append'} onChange={(value) => formActions().updatePollResult({
                          download: { ...pollResult.download!, pathMode: value as 'append' | 'origin' },
                        })}>
                          <option value="append">{t('连接地址')}</option>
                          <option value="origin">{t('域名根路径')}</option>
                        </Select>
                      </label>
                    </div>
                    <label className="provider-protocol-field">
                      <span>{t('备用 MIME 类型')}</span>
                      <input value={pollResult.mimeType ?? ''} placeholder={model.category === 'audio' ? 'audio/mpeg' : 'video/mp4'}
                        onChange={(event) => formActions().updatePollResult({ mimeType: event.target.value || undefined })} />
                    </label>
                    <p className="text-xs text-canvas-text-muted">{t('仅在轮询成功后读取，同源校验与鉴权沿用当前连接；高级请求头和 Query 可在 JSON 中配置。')}</p>
                  </>
                ) : (
                  <div className="provider-protocol-grid is-three">
                    <label className="provider-protocol-field">
                      <span>{t('URL 结果路径')}</span>
                      <input value={pollResult?.urlPath ?? ''} onChange={(event) => formActions().updatePollResult({
                        urlPath: event.target.value || undefined,
                      })} />
                    </label>
                    <label className="provider-protocol-field">
                      <span>{t('文本结果路径')}</span>
                      <input value={pollResult?.textPath ?? ''} onChange={(event) => formActions().updatePollResult({
                        textPath: event.target.value || undefined,
                      })} />
                    </label>
                    <label className="provider-protocol-field">
                      <span>{t('Base64 结果路径')}</span>
                      <input value={pollResult?.base64Path ?? ''} onChange={(event) => formActions().updatePollResult({
                        base64Path: event.target.value || undefined,
                      })} />
                    </label>
                    {pollResult?.base64Path ? (
                      <label className="provider-protocol-field">
                        <span>{t('Base64 MIME 类型')}</span>
                        <input
                          value={pollResult.mimeType ?? ''}
                          placeholder={model.category === 'video' ? 'video/mp4' : model.category === 'audio' ? 'audio/mpeg' : 'image/png'}
                          onChange={(event) => formActions().updatePollResult({ mimeType: event.target.value || undefined })}
                        />
                      </label>
                    ) : null}
                  </div>
                )}
                <div className="provider-protocol-grid">
                  <label className="provider-protocol-field">
                    <span>{t('错误路径')}</span>
                    <input value={pollResponse?.errorPath ?? ''} onChange={(event) => formActions().updatePollResponse({ errorPath: event.target.value || undefined })} />
                  </label>
                  <label className="provider-protocol-field">
                    <span>{t('进度路径')}</span>
                    <input value={pollResponse?.progressPath ?? ''} onChange={(event) => formActions().updatePollResponse({ progressPath: event.target.value || undefined })} />
                  </label>
                </div>
                <details className="border-t border-canvas-border pt-2.5 text-[12px] text-canvas-text-muted">
                  <summary className="w-fit cursor-pointer select-none text-canvas-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canvas-text-muted">
                    {t('轮询与重试策略')}
                  </summary>
                  <div className="mt-2 flex min-w-0 flex-col gap-2">
                    <div className="provider-protocol-grid is-three">
                      <label className="provider-protocol-field">
                        <span>{t('最大轮询次数')}</span>
                        <input
                          type="number"
                          min={1}
                          max={10000}
                          value={poll.maxAttempts ?? ''}
                          onChange={(event) => formActions().updatePoll({
                            maxAttempts: Number.isFinite(event.target.valueAsNumber)
                              ? event.target.valueAsNumber
                              : undefined,
                          })}
                        />
                      </label>
                      <label className="provider-protocol-field">
                        <span>{t('最长时长（秒）')}</span>
                        <input
                          type="number"
                          min={1}
                          max={86400}
                          value={poll.maxDurationMs === undefined ? '' : poll.maxDurationMs / 1000}
                          onChange={(event) => formActions().updatePoll({
                            maxDurationMs: Number.isFinite(event.target.valueAsNumber)
                              ? Math.round(event.target.valueAsNumber * 1000)
                              : undefined,
                          })}
                        />
                      </label>
                      <label className="provider-protocol-field">
                        <span>{t('错误重试次数')}</span>
                        <input
                          type="number"
                          min={0}
                          max={10}
                          value={pollRetry.maxRetries}
                          onChange={(event) => formActions().updatePollRetry({ maxRetries: event.target.valueAsNumber })}
                        />
                      </label>
                    </div>
                    <div className="provider-protocol-grid is-three">
                      <label className="provider-protocol-field">
                        <span>{t('退避策略')}</span>
                        <Select fixedMenu
                          value={pollRetry.backoff}
                          onChange={(selectedOptionValue) => formActions().updatePollRetry({
                            backoff: selectedOptionValue as ModelProtocolPollRetryConfig['backoff'],
                          })}
                        >
                          <option value="fixed">{t('固定间隔')}</option>
                          <option value="linear">{t('线性增加')}</option>
                          <option value="exponential">{t('指数增加')}</option>
                        </Select>
                      </label>
                      <label className="provider-protocol-field">
                        <span>{t('最大重试间隔 ms')}</span>
                        <input
                          type="number"
                          min={1000}
                          max={300000}
                          value={pollRetry.maxDelayMs}
                          onChange={(event) => formActions().updatePollRetry({ maxDelayMs: event.target.valueAsNumber })}
                        />
                      </label>
                      <label className="provider-protocol-field">
                        <span>{t('重试 HTTP 状态码')}</span>
                        <input
                          value={pollRetry.httpStatuses.join(', ')}
                          onChange={(event) => formActions().updatePollRetry({
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
                          onChange={(event) => formActions().updatePollRetry({ honorRetryAfter: event.target.checked })}
                        />
                        <span>{t('遵循 Retry-After')}</span>
                      </label>
                      <label className="provider-protocol-toggle">
                        <input
                          type="checkbox"
                          checked={pollRetry.retryNetworkErrors}
                          onChange={(event) => formActions().updatePollRetry({ retryNetworkErrors: event.target.checked })}
                        />
                        <span>{t('重试网络错误')}</span>
                      </label>
                    </div>
                  </div>
                </details>
              </>
            ) : null}
          </section>

          <details className="provider-protocol-variables">
            <summary>{t('可用变量')}</summary>
            <div>
              {availableVariables.map((variable) => (
                <code key={variable} data-tooltip={t(getVariableTooltip(variable))}>
                  {`{{${variable}}}`}
                </code>
              ))}
              {protocol.mode === 'async' ? (
                <code data-tooltip={t(SUBMIT_TASK_ID_DESCRIPTION)}>{`{{${submitTaskIdVariable}}}`}</code>
              ) : null}
            </div>
          </details>
        </div>
      ) : null}

      {preset === 'custom' && !readOnlyProtocol && (simpleEditor || view === 'json') ? (
        <div className="min-w-0 space-y-3">
          <div className={PROTOCOL_JSON_EDITOR_LAYOUT}>
            <ProtocolVariablePanel
              variables={[...availableVariables, ...(protocol.mode === 'async' ? [submitTaskIdVariable] : [])]}
              textareaId={protocolJsonId} onInsert={insertProtocolVariable} t={t} submitTaskIdVariable={submitTaskIdVariable}
            />
            <div className="provider-protocol-field provider-protocol-full-json">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor={protocolJsonId} className="text-xs text-canvas-text-secondary">{t('声明式协议 JSON')}</label>
                {videoJsonEditor ? (
                  <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('视频 JSON 预设')}>
                    <span className="text-[10px] text-canvas-text-muted">APIMart</span>
                    {(['sd2.0', 'sd2.5', 'h3'] as const).map((templateId) => (
                      <button
                        key={templateId}
                        type="button"
                        className="ui-btn ui-btn--sm"
                        aria-label={t('填入 {name} 视频预设（APIMart）', { name: templateId.toUpperCase() })}
                        title={t('替换当前 JSON，并应用对应的视频参数能力；保留当前模型 ID')}
                        onClick={() => applyVideoJsonTemplate(templateId)}
                      >
                        {templateId.toUpperCase()}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <textarea
                ref={protocolTextareaRef}
                id={protocolJsonId}
                className="flex-auto"
                value={protocolJson}
                rows={26}
                spellCheck={false}
                aria-invalid={!!error}
                aria-describedby={protocolJsonHelpId}
                onFocus={(event) => rememberProtocolSelection(event.currentTarget)}
                onSelect={(event) => rememberProtocolSelection(event.currentTarget)}
                onBlur={(event) => rememberProtocolSelection(event.currentTarget)}
                onChange={(event) => {
                  rememberProtocolSelection(event.currentTarget);
                  updateCustomJson(event.target.value);
                }}
              />
            </div>
          </div>

          <details className="text-xs text-canvas-text-secondary">
            <summary className="cursor-pointer">{t('JSON 字段说明')}</summary>
          <aside id={protocolJsonHelpId} className="provider-protocol-json-help">
            <div className="provider-protocol-json-guide-title">
              <Icon icon="mdi:information-outline" width="13" />
              <strong>{t('配置说明')}</strong>
              <span>{simpleEditor
                ? t('选择预设即可使用；接口不兼容时按文档编辑 JSON。')
                : t('不确定如何填写时，可先在“表单”模式配置，再切回 JSON 查看结果')}</span>
            </div>
            <dl>
              <div>
                <dt><code>version</code> / <code>mode</code></dt>
                <dd>{t('协议版本固定为 2；mode 使用 sync 同步返回或 async 异步轮询。')}</dd>
              </div>
              <div>
                <dt><code>auth</code></dt>
                <dd>{t('定义 API Key 的注入方式。只配置 type、name、prefix，不要把真实密钥写进 JSON。')}</dd>
              </div>
              <div>
                <dt><code>submit</code></dt>
                <dd>{t('首次请求规则，包括 method、path、query、headers、bodyEncoding 和 body。')}</dd>
              </div>
              <div>
                <dt><code>response</code></dt>
                <dd>{t('首次响应的解析规则。同步模式从 result 取结果；异步模式用 taskIdPath 取得任务 ID。')}</dd>
              </div>
              <div>
                <dt><code>poll</code></dt>
                <dd>{t('仅异步模式需要，定义查询请求、完成/失败状态、结果路径、查询间隔与重试策略。')}</dd>
              </div>
              <div>
                <dt>{t('响应路径')}</dt>
                <dd>{t('用点号读取嵌套字段，例如 data.0.url；用 data.*.url 读取数组内全部 URL。')}</dd>
              </div>
              <div>
                <dt><code>poll.response.result.download</code></dt>
                <dd>{t('轮询成功后发送同源 GET 请求下载二进制；path 或 query 必须引用本次提交任务 ID，鉴权由连接注入。与 URL、文本、Base64 和 fetchUrl 映射互斥。')}</dd>
              </div>
            </dl>
            {protocol.mode === 'async' ? (
              <p>
                {t('异步流程先按 response.taskIdPath 取得任务 ID，再在 poll 中引用：')} <code>{`{{${submitTaskIdVariable}}}`}</code>
              </p>
            ) : null}
          </aside>
          </details>
        </div>
      ) : null}

      {readOnlyProtocol && preset === 'custom' ? (
        <details className="text-xs text-canvas-text-secondary">
          <summary className="cursor-pointer">{t('声明式协议 JSON')}</summary>
          <pre tabIndex={0} role="region" aria-label={t('声明式协议 JSON')}
            className="max-h-80 overflow-auto whitespace-pre-wrap break-all p-2 font-mono"><code>{protocolJson}</code></pre>
        </details>
      ) : null}

      {preset === 'custom' ? (
        <div className="space-y-3">
          <details className="border-t border-canvas-border pt-2.5 text-[12px] text-canvas-text-muted">
            <summary className="w-fit cursor-pointer select-none text-canvas-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canvas-text-muted">
              {t('本地请求预览')}
            </summary>
            <div className="mt-2 grid min-w-0 grid-cols-2 gap-2 max-[700px]:grid-cols-1">
              <div className="provider-protocol-field min-w-0">
                <label htmlFor={previewVariablesId} className="text-[12px] text-canvas-text-muted">
                  {t('示例变量 JSON')}
                </label>
                <textarea
                  id={previewVariablesId}
                  className="flex-1"
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
                    {t(previewState.error)}
                  </small>
                ) : null}
              </div>
              <div className="flex min-w-0 flex-col gap-2" aria-live="polite">
                <div className="flex min-w-0 items-center gap-2 rounded-md border border-canvas-border bg-canvas-bg/40 px-2.5 py-2">
                  <span className="shrink-0 font-mono text-[12px] font-semibold text-canvas-text-secondary">
                    {previewState.preview?.method ?? '--'}
                  </span>
                  <code className="min-w-0 break-all text-[12px] text-canvas-text">
                    {previewState.preview?.relativeUrl ?? t('请求路径不可用')}
                  </code>
                </div>
                <div className="provider-protocol-field min-w-0">
                  <span>{t('Header 预览')}</span>
                  <pre className="max-h-32 min-h-20 overflow-auto whitespace-pre-wrap break-all rounded-md border border-canvas-border bg-canvas-bg/40 p-2.5 font-mono text-[12px] leading-relaxed text-canvas-text-secondary">
                    {previewState.preview ? serializeJson(previewState.preview.headers) : '{}'}
                  </pre>
                </div>
                <div className="provider-protocol-field min-w-0">
                  <span>{t('Body 预览')}</span>
                  <pre className="max-h-48 min-h-28 overflow-auto whitespace-pre-wrap break-all rounded-md border border-canvas-border bg-canvas-bg/40 p-2.5 font-mono text-[12px] leading-relaxed text-canvas-text-secondary">
                    {previewState.preview?.body === undefined ? t('无请求体') : serializeJson(previewState.preview.body)}
                  </pre>
                </div>
              </div>
            </div>
          </details>
          {supportsStructuredResponse ? (
            <details className="provider-protocol-response-preview" open>
              <summary>{t('响应示例与路径校验')}</summary>
              <div className="provider-protocol-response-preview-content">
                <div className="provider-protocol-field min-w-0">
                  <label htmlFor={responseSampleId}>{t('响应示例 JSON')}</label>
                  <textarea
                    id={responseSampleId}
                    className="flex-1"
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
                      {t(responsePreviewState.error)}
                    </small>
                  ) : null}
                </div>
                <div className="provider-protocol-response-results" aria-live="polite">
                  <span>{t('路径解析结果')}</span>
                  {responsePreviewState.entries?.map((entry) => (
                    <div key={entry.id} className="provider-protocol-response-result">
                      <div>
                        <strong>{entry.label}</strong>
                        <code>{entry.path}</code>
                      </div>
                      <code className={entry.matchCount > 0 ? 'is-matched' : ''}>
                        {entry.matchCount > 0 ? entry.values.join(' | ') : t('未匹配')}
                      </code>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="provider-protocol-error" role="alert">
          <Icon icon="mdi:alert-circle-outline" width="14" />
          <span>{t(error ?? '')}</span>
        </div>
      ) : null}
    </section>
  );
}
