import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { ProviderModelSelection } from '../../../types';
import type { NormalizedModelExecutionProtocol, ProtocolJsonValue } from '../../../types/aiTypes';
import {
  previewModelProtocolRequest,
  previewModelProtocolResponse,
  type ModelProtocolRequestPreview,
  type ModelProtocolResponsePreviewEntry,
  type ModelProtocolVariables,
} from '../../../services/ai/modelProtocol';
import {
  assertRealProtocolTestVariables,
  buildImageTestVariables,
  buildVideoTestVariables,
  defaultVideoTestScenario,
  describeProtocolTestRunBlocker,
  resolveProtocolTestRunDraft,
  nativeProtocolTestMessages,
  type ProtocolChoice,
  type VideoTestReferences,
  type VideoTestScenario,
} from '../modelProtocolTestRun';
import type { useT } from '../../../i18n';
import { buildGoogleImageParts, resolveImageTemplateDimensions } from '../../../services/ai/imageModelTemplates';
import { resolveConfiguredImageOutput } from '../../../services/ai/imageOutputParameters';
import { prepareProtocolMediaFileRequest } from '../../../services/ai/modelProtocolMediaFiles';
import { PREPARED_MULTIPART_FILES } from '../../../services/ai/modelProtocolTemplate';
import {
  buildChatApiRequest,
  getMagpieChatBudgetOptions,
  isNativeTextProtocolPreset,
  parseChatApiResponse,
  resolveNativeTextChatProtocol,
} from '../../../services/ai/chatApiProtocol';
import { resolveTextModelContextSpec } from '../../nodes/shared/defaultModels';
import { resolveMagpieContextWindow } from '../../../services/ai/providerPolicies';
import { resolveKlingModelContract } from '../../../services/ai/providerCatalogService';
import { resolveEffectivePromptLimits } from '../../../services/ai/imagePromptLimits';
import { resolveConfiguredVideoCapability } from '../../../services/ai/videoModelCapabilityResolver';
import { assertKlingImageResponse } from '../../../services/ai/providers/klingImageResponse';
import { corsSafeFetch } from '../../../services/ai/httpTransport';
import { parseResponseError } from '../../../services/ai/httpUtils';
import { assertModelProtocolResult, assertModelProtocolResultMapping, resolveConfiguredImageBackground } from '../../../services/ai/modelCapabilityValidation';
import {
  discardProtocolTestSession,
  getProtocolTestSession,
  pauseProtocolTestSession,
  resumeProtocolTestSession,
  startProtocolTestSession,
  subscribeProtocolTestSession,
  ProtocolTestSessionError,
} from '../../../services/ai/modelProtocolTestSession';
import { useAppStore } from '../../../store/useAppStore';
import type { PluginModelProtocolReference } from '../../../types/plugin';
import { resolvePluginModelProtocol } from '../../../services/ai/pluginModelProtocol';
import { isJsonObject, serializeJson } from './protocolFormMappings';
import { assertSandOrigin, sandProtocolFor, sandSite } from '../../../services/ai/providers/sandVideoContract';
import { assertMagiGatewayOrigin, magiGatewayProtocol, magiVideoGateway } from '../../../services/ai/providers/magiVideoGateways';

interface ProtocolPreviewState {
  preview?: ModelProtocolRequestPreview;
  error?: string;
}

interface ProtocolTestRunState {
  status: 'idle' | 'running' | 'success' | 'error';
  message?: string;
  /** 成功时的结果摘要，不保留完整响应或内联媒体正文。 */
  detail?: string;
}

interface ProtocolResponsePreviewState {
  entries?: ModelProtocolResponsePreviewEntry[];
  error?: string;
}

export function createPreviewVariables(model: ProviderModelSelection): ModelProtocolVariables {
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
    const imageSize = model.imageCapability?.defaultResolution ?? model.imageCapability?.resolutions?.[0] ?? '1K';
    const aspectRatio = model.imageCapability?.defaultRatio ?? model.imageCapability?.ratios?.[0] ?? '1:1';
    const imageUrls: string[] = [];
    // 未完成的编辑草稿不能让整个设置窗口加载失败；真实发送仍严格校验尺寸。
    let dimensions = { width: 1024, height: 1024 };
    let imageBackground: string | undefined;
    let imageOutput: ReturnType<typeof resolveConfiguredImageOutput> = {};
    try { dimensions = resolveImageTemplateDimensions(model.imageCapability, imageSize, aspectRatio); } catch { /* 保留预览占位 */ }
    try { imageBackground = resolveConfiguredImageBackground(model.imageCapability); } catch { /* 无效能力留待保存时报告 */ }
    try { imageOutput = resolveConfiguredImageOutput(model.imageCapability, {}); } catch { /* 编辑草稿留待保存时校验 */ }
    const count = model.imageCapability?.minBatchCount ?? 1;
    return {
      ...common,
      imageSize,
      imageQuality: model.imageCapability?.qualities?.length ? model.imageCapability.defaultQuality : undefined,
      imageBackground,
      ...imageOutput,
      aspectRatio,
      size: `${dimensions.width}x${dimensions.height}`,
      ...dimensions,
      n: count,
      batchCount: count,
      imageUrls: imageUrls.length ? imageUrls : undefined,
      googleImageParts: buildGoogleImageParts(common.prompt, imageUrls),
    };
  }
  if (model.category === 'video') {
    const gateway = magiVideoGateway(model.provider, model.id);
    return {
      ...common,
      ...(sandSite(model.provider, model.id) ? { sandContent: [{ type: 'text', text: common.prompt }] } : {}),
      ...(gateway ? { gatewayVideoBody: { prompt: common.prompt, duration: model.videoCapability?.defaultDuration ?? 5,
        aspect_ratio: model.videoCapability?.defaultRatio ?? '16:9', resolution: '1080p',
        ...(gateway.id === 'beatapi' ? { model: model.id } : {}) } } : {}),
      duration: model.videoCapability?.defaultDuration ?? model.videoCapability?.durations?.[0] ?? model.videoCapability?.minDuration,
      aspectRatio: model.videoCapability?.defaultRatio ?? model.videoCapability?.ratios?.[0],
      seedanceResolution: model.videoCapability?.defaultResolution ?? model.videoCapability?.resolutions?.[0],
      fps: model.videoCapability?.defaultFrameRate ?? model.videoCapability?.frameRates?.[0],
      n: 1,
      batchCount: 1,
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
    n: 1,
    batchCount: 1,
  };
}

function createResponseSample(): ProtocolJsonValue {
  return {
    task_id: 'task_example',
    video_id: 'video_example',
    id: 'task_example',
    status: 'completed',
    progress: 100,
    url: 'https://cdn.example/result.mp4',
    video_url: 'https://cdn.example/result.mp4',
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

export function useProtocolTrial({
  model, catalogId, initialPreviewVariables, workflowMode, testSessionScope, apiKey, baseUrl, preset,
  protocol, protocolJson, error, invalidFormFieldsRef, pluginReference, pluginUnavailable, t,
}: {
  model: ProviderModelSelection;
  catalogId?: string;
  initialPreviewVariables?: ModelProtocolVariables;
  workflowMode: boolean;
  testSessionScope?: string;
  apiKey: string;
  baseUrl: string;
  preset: ProtocolChoice;
  protocol: NormalizedModelExecutionProtocol;
  protocolJson: string;
  error: string | null;
  invalidFormFieldsRef: RefObject<Set<string>>;
  pluginReference?: PluginModelProtocolReference;
  pluginUnavailable: boolean;
  t: ReturnType<typeof useT>;
}) {
  const [previewVariablesJson, setPreviewVariablesJson] = useState(
    () => serializeJson(initialPreviewVariables ?? createPreviewVariables(model)),
  );
  const [testVariablesJson, setTestVariablesJson] = useState(
    () => serializeJson(initialPreviewVariables ?? createPreviewVariables(model)),
  );
  const [testScenario, setTestScenario] = useState<VideoTestScenario>(() => defaultVideoTestScenario(model));
  const klingVideoContract = useMemo(() => {
    if (catalogId !== 'kling' || workflowMode || model.category !== 'video' || preset !== 'custom') return undefined;
    try {
      const profile = { preset: 'custom' as const, protocol: JSON.parse(protocolJson) as NormalizedModelExecutionProtocol };
      return resolveKlingModelContract(model.id, profile);
    } catch { return undefined; }
  }, [catalogId, workflowMode, model.category, model.id, preset, protocolJson]);
  const klingFrameMode = klingVideoContract?.videoFrameMode;
  const sand = workflowMode ? undefined : sandSite(catalogId, model.id);
  const gateway = workflowMode ? undefined : magiVideoGateway(catalogId, model.id);
  const supportsTestKeyframes = sand?.variant !== 'v2';
  const activeTestScenario = klingVideoContract ? defaultVideoTestScenario(klingVideoContract)
    : !supportsTestKeyframes && testScenario === 'keyframe' ? 'reference' : testScenario;
  const [testReferences, setTestReferences] = useState<VideoTestReferences>({ firstImage: '', lastImage: '', images: '', videos: '', audios: '' });
  const sessionIdentity = useMemo(() => ({
    scopeId: testSessionScope ?? (model.provider || 'protocol-editor'), modelId: model.id, baseUrl,
  }), [testSessionScope, model.provider, model.id, baseUrl]);
  const sessionObserver = useMemo(() => ({
    subscribe: (listener: () => void) => subscribeProtocolTestSession(sessionIdentity, listener),
    getSnapshot: () => getProtocolTestSession(sessionIdentity),
  }), [sessionIdentity]);
  const session = useSyncExternalStore(sessionObserver.subscribe, sessionObserver.getSnapshot, () => undefined);
  const [responseSampleJson, setResponseSampleJson] = useState(
    () => serializeJson(sand?.variant === 'v2'
      ? { id: '9223372036854775807', status: 'succeeded', output: { videoUrl: 'https://cdn.example/result.mp4' } }
      : sand ? { id: '9223372036854775807', model: 'magi-2', status: 'succeeded', content: { video_url: 'https://cdn.example/result.mp4' } }
        : createResponseSample()),
  );
  const testRunContext = useMemo(() => ({ identity: sessionIdentity, authenticated: !!apiKey.trim() }), [sessionIdentity, apiKey]);
  const [testRunState, setTestRunState] = useState<{ context: object; value: ProtocolTestRunState }>(
    () => ({ context: testRunContext, value: { status: 'idle' } }),
  );
  const testRun: ProtocolTestRunState = testRunState.context === testRunContext ? testRunState.value : { status: 'idle' };
  const setTestRun = (value: ProtocolTestRunState) => setTestRunState({ context: testRunContext, value });
  const testAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => { testAbortRef.current?.abort(); pauseProtocolTestSession(sessionIdentity); }, [sessionIdentity, apiKey]);
  useEffect(() => () => testAbortRef.current?.abort(), []);
  const previewState = useMemo<ProtocolPreviewState>(() => {
    if (preset !== 'custom') return {};
    try {
      if (error) throw new Error(error);
      const parsed = JSON.parse(previewVariablesJson) as ProtocolJsonValue;
      if (!isJsonObject(parsed)) throw new Error('示例变量必须是 JSON 对象');
      const currentProtocol = resolveProtocolTestRunDraft(
        preset, protocol, protocolJson,
      );
      return {
        preview: previewModelProtocolRequest({
          baseUrl: baseUrl.trim() || 'https://preview.invalid',
          protocol: currentProtocol,
          variables: parsed,
        }),
      };
    } catch (previewError) {
      return {
        error: previewError instanceof Error ? previewError.message : '请求预览失败',
      };
    }
  }, [preset, previewVariablesJson, protocol, protocolJson, baseUrl, error]);
  const supportsStructuredResponse = protocol.mode === 'async'
    || protocol.response.type === 'json';
  const responsePreviewState = useMemo<ProtocolResponsePreviewState>(() => {
    if (preset !== 'custom' || !supportsStructuredResponse) return {};
    try {
      if (error) throw new Error(error);
      const parsed = JSON.parse(responseSampleJson) as ProtocolJsonValue;
      if (!isJsonObject(parsed) && !Array.isArray(parsed)) {
        throw new Error('响应示例必须是 JSON 对象或数组');
      }
      const currentProtocol = resolveProtocolTestRunDraft(
        preset, protocol, protocolJson,
      );
      return { entries: previewModelProtocolResponse(currentProtocol, parsed) };
    } catch (previewError) {
      return {
        error: previewError instanceof Error ? previewError.message : '返回值结构预览失败',
      };
    }
  }, [preset, protocol, protocolJson, responseSampleJson, supportsStructuredResponse, error]);

  /**
   * 拿真实凭据把当前协议跑一次。
   *
   * 本地预览只能证明模板渲染得出来，证明不了厂商认这些字段——中转站最常见的失败
   * 是 400 unsupported field，只有真发一次请求才看得到。这会产生真实调用与计费，
   * 所以只在用户点按钮时执行；拿到任务 ID 后可暂停、续查，不重提生成。
   */
  const describeTestError = (testError: unknown): string => {
    if (testError instanceof ProtocolTestSessionError) {
      const messages = {
        'invalid-identity': '试跑连接地址无效，请检查接口地址',
        'existing-session': '已有试跑记录，请先继续查询或放弃记录',
        'session-limit': '保留的试跑任务过多，请先处理已有记录',
        'not-resumable': '当前任务暂时不能继续查询',
        busy: '任务仍在处理中，请稍后操作',
        paused: '查询已暂停',
        'submission-uncertain': '提交状态不确定，请先到厂商后台确认',
        'different-origin': '任务查询地址与当前连接不同源',
        'different-credential': '原任务的 API Key 已变化，请恢复原 Key 后继续查询',
      };
      return t(messages[testError.code]);
    }
    return t(testError instanceof Error ? testError.message.split(apiKey || '\0').join('[REDACTED]') : '试跑失败');
  };
  const resultDetail = (result: { urls?: string[]; text?: string; taskId?: string }) => serializeJson({
    ...result, urls: result.urls?.map((url) => url.startsWith('data:') ? '[inline media]' : url),
    text: result.text?.slice(0, 2000),
  }).split(apiKey || '\0').join('[REDACTED]');

  const runProtocolTest = async () => {
    if (testAbortRef.current && !testAbortRef.current.signal.aborted) return;
    if (getProtocolTestSession(sessionIdentity)) return;
    if (describeProtocolTestRunBlocker(preset, apiKey, baseUrl, !!error || invalidFormFieldsRef.current.size > 0)) return;
    let variables: ModelProtocolVariables;
    try {
      const parsed = JSON.parse(testVariablesJson) as ProtocolJsonValue;
      if (!isJsonObject(parsed)) throw new Error('试跑变量必须是 JSON 对象');
      delete parsed[PREPARED_MULTIPART_FILES];
      assertRealProtocolTestVariables(parsed);
      variables = workflowMode ? parsed : { ...parsed, model: model.id };
    } catch (parseError) {
      setTestRun({
        status: 'error',
        message: describeTestError(parseError),
      });
      return;
    }
    testAbortRef.current?.abort();
    const controller = new AbortController();
    testAbortRef.current = controller;
    setTestRun({ status: 'running' });
    let lease: Awaited<ReturnType<typeof resolvePluginModelProtocol>> | undefined;
    try {
      if (preset === 'plugin') lease = await resolvePluginModelProtocol({ preset: 'plugin', plugin: pluginReference }, () => useAppStore.getState().installedPlugins, controller);
      const nativeChatProtocol = lease?.adapter ?? (isNativeTextProtocolPreset(preset) || preset === 'openai-chat'
        ? resolveNativeTextChatProtocol({ preset }, catalogId)
        : undefined);
      let result: { urls?: string[]; text?: string; taskId?: string };
      if (nativeChatProtocol) {
        const outputLimit = model.catalogTextLimits?.maxOutputTokens;
        const budget = catalogId === 'magpie' && model.category === 'text' && !lease
          ? resolveTextModelContextSpec({ modelId: model.id, contextWindow: resolveMagpieContextWindow(model),
            catalogMaxOutputTokens: outputLimit }) : undefined;
        const request = buildChatApiRequest({
          protocol: nativeChatProtocol,
          apiKey,
          baseUrl,
          model: model.id,
          messages: nativeProtocolTestMessages(variables),
          stream: false,
          ...getMagpieChatBudgetOptions(nativeChatProtocol, budget, outputLimit !== undefined),
          signal: controller.signal,
        });
        await lease?.assertCurrent();
        controller.signal.throwIfAborted();
        const response = await corsSafeFetch(request.url, request.init);
        if (!response.ok) await parseResponseError(response, `API 请求失败 (${response.status})`);
        const payload: unknown = await response.json();
        await lease?.assertCurrent();
        result = { text: parseChatApiResponse(payload, nativeChatProtocol).text };
      } else {
        if (sand) assertSandOrigin(sand.id, baseUrl.trim());
        if (gateway) assertMagiGatewayOrigin(gateway, baseUrl.trim());
        const currentProtocol = sand ? sandProtocolFor(sand.id)
          : gateway ? magiGatewayProtocol(gateway, activeTestScenario === 'keyframe' ? 'image-to-video'
            : activeTestScenario === 'reference' ? 'reference-to-video' : 'text-to-video')
          : resolveProtocolTestRunDraft(
          preset, protocol, protocolJson, invalidFormFieldsRef.current.size > 0,
        );
        assertModelProtocolResultMapping(model.category, currentProtocol);
        const kling = !workflowMode && catalogId === 'kling'
          ? resolveKlingModelContract(model.id, { preset: 'custom', protocol: currentProtocol }) : undefined;
        if (!workflowMode && model.category === 'video') {
          const testModel = kling || sand || gateway ? { ...model, videoCapability: resolveConfiguredVideoCapability(
            catalogId, model.id, { preset: 'custom', protocol: currentProtocol }, model.videoCapability,
          ) } : model;
          const references = kling?.videoFrameMode === 'single' ? { ...testReferences, lastImage: '' } : testReferences;
          variables = await buildVideoTestVariables(testModel, activeTestScenario, references, variables, kling?.videoFrameMode, sand?.variant, gateway);
        } else if (!workflowMode && model.category === 'image') {
          const verified = kling?.imageCapability;
          const testModel = verified ? {
            ...model,
            imageCapability: { ...verified, ...resolveEffectivePromptLimits(verified, model.imageCapability) },
          } : model;
          variables = await buildImageTestVariables(testModel, variables, Boolean(kling), controller.signal);
        }
        const { protocol: submitProtocol, variables: submitVariables } = !workflowMode && preset === 'custom' && currentProtocol.submit.bodyEncoding === 'multipart'
          && (model.category === 'image' || model.category === 'video')
          ? await prepareProtocolMediaFileRequest(currentProtocol, variables, { signal: controller.signal, trial: true })
          : { protocol: currentProtocol, variables };
        if (controller.signal.aborted) return;
        const imageOutputCountRange = model.category === 'image' && !workflowMode
          ? (kling ?? model).imageCapability?.outputCountRange : undefined;
        result = await startProtocolTestSession({
          identity: sessionIdentity, category: model.category, apiKey, protocol: submitProtocol, variables: submitVariables,
          ...(kling?.imageCapability ? { validateResponse: assertKlingImageResponse } : {}),
          ...(imageOutputCountRange ? { imageOutputCountRange } : {}),
        });
      }
      if (controller.signal.aborted) return;
      assertModelProtocolResult(model.category, result);
      const parts = [
        result.urls?.length ? t('返回 {count} 个结果地址', { count: result.urls.length }) : '',
        result.text ? t('返回文本 {count} 字', { count: result.text.length }) : '',
        result.taskId ? t('任务 ID {id}', { id: result.taskId }) : '',
      ].filter(Boolean);
      setTestRun({
        status: 'success',
        message: parts.join('，') || t('调用成功，但没有解析出结果'),
        detail: resultDetail(result),
      });
    } catch (runError) {
      if (controller.signal.aborted) {
        if (testAbortRef.current === controller) setTestRun({ status: 'error', message: t('协议调用已取消，请检查插件状态后重试。') });
        return;
      }
      setTestRun({
        status: 'error',
        message: describeTestError(runError),
      });
    } finally {
      lease?.release();
      if (testAbortRef.current === controller) testAbortRef.current = null;
    }
  };

  const resumeProtocolTest = async () => {
    if (testAbortRef.current && !testAbortRef.current.signal.aborted) return;
    if (!apiKey.trim() || !getProtocolTestSession(sessionIdentity)?.canResume) return;
    setTestRun({ status: 'running' });
    const controller = new AbortController();
    testAbortRef.current = controller;
    try {
      const result = await resumeProtocolTestSession({ identity: sessionIdentity, apiKey });
      if (controller.signal.aborted) return;
      assertModelProtocolResult(session?.category ?? model.category, result);
      setTestRun({ status: 'success', message: t('原任务查询完成，未重新提交生成'),
        detail: resultDetail(result) });
    } catch (queryError) {
      if (controller.signal.aborted) return;
      setTestRun({ status: 'error', message: describeTestError(queryError) });
    } finally {
      if (testAbortRef.current === controller) testAbortRef.current = null;
    }
  };

  const cancelProtocolTest = () => {
    testAbortRef.current?.abort();
    testAbortRef.current = null;
    pauseProtocolTestSession(sessionIdentity);
    setTestRun({ status: 'idle' });
  };

  const trialRunning = testRun.status === 'running' || session?.status === 'submitting' || session?.status === 'polling';
  const sessionMessage = session?.status === 'uncertain'
    ? t('提交状态不确定，请先到厂商后台确认；不会自动重新提交。')
    : session?.status === 'paused'
      ? t('查询已暂停，任务仍保留；继续查询不会重新生成。')
      : session?.status === 'failed' ? t('上游任务已失败，不能继续查询生成结果。') : '';

  const testRunBlocker = describeProtocolTestRunBlocker(preset, apiKey, baseUrl, !!error || pluginUnavailable);
  const testRunDisabledReason = testRunBlocker === 'legacy-preset'
    ? t('「自动兼容」不走声明式协议，无法试跑')
    : testRunBlocker === 'missing-base-url'
      ? t('先填写接口地址')
      : testRunBlocker === 'missing-api-key'
        ? t('先填写 API Key')
        : testRunBlocker === 'invalid-draft'
          ? t('先修正当前协议草稿中的错误')
          : '';

  const resetTrialForTemplate = () => {
    testAbortRef.current?.abort();
    pauseProtocolTestSession(sessionIdentity);
    testAbortRef.current = null;
    setTestRun({ status: 'idle' });
  };
  const discardTrial = () => {
    discardProtocolTestSession(sessionIdentity);
    setTestRun({ status: 'idle' });
  };

  return {
    previewVariablesJson, setPreviewVariablesJson, testVariablesJson, setTestVariablesJson,
    setTestScenario, klingVideoContract, klingFrameMode, activeTestScenario, supportsTestKeyframes,
    testReferences, setTestReferences, session, responseSampleJson,
    setResponseSampleJson, testRun, previewState, supportsStructuredResponse, responsePreviewState,
    runProtocolTest, resumeProtocolTest, cancelProtocolTest, trialRunning, sessionMessage,
    testRunDisabledReason, discardTrial, resetTrialForTemplate,
  };
}
