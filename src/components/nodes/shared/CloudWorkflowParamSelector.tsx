/**
 * CloudWorkflowParamSelector — 复用本地与云工作流的参数浮层。
 */
import { Icon } from '@iconify/react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { WorkflowDefinition } from '../../../types';
import type { ComfyInputSpec, ComfyWorkflowParameter } from '../../../types/comfyWorkflow';
import { useAppStore } from '../../../store/useAppStore';
import { useT } from '../../../i18n';
import { getCloudWorkflowParameterSemantic, type CloudWorkflowParameterSemantic } from '../../../services/cloudWorkflowParameterControls';
import { resolveRunningHubParameters, runningHubParameterKey } from '../../../services/runninghubWorkflowService';
import { calcAnchoredPosition } from '../../../utils/popupPosition';
import AnimatedButton from '../../shared/AnimatedButton';
import RunningHubParameterFields from './RunningHubParameterFields';
import WorkflowApiParameterFields from './WorkflowApiParameterFields';
import ComfyWorkflowParameterFields from './ComfyWorkflowParameterFields';
import type { ComfyVideoParameterFields } from './VideoParamSelector';
import { comfyBaseUrlFor } from '../../../services/comfyServers';
import { fetchNodeInputSpecs } from '../../../services/comfyWorkflowService';
import { comfyWorkflowParameterKey, loadComfyWorkflowParameters, splitComfyWorkflowInputs } from '../../../services/comfyWorkflowParameters';
import { estimateComfyH3VideoSize, injectVideoParamsIntoWorkflow } from '../../../services/comfyWorkflow/workflowDimensions';
import { resolveVideoSubmissionControls, type VideoSubmissionControlParams } from '../../../services/ai/videoRequestResolver';

interface CloudWorkflowParamSelectorProps {
  workflow: WorkflowDefinition;
  values?: Record<string, string>;
  onChange: (values: Record<string, string>, aspectRatio?: string) => void;
  disabled?: boolean;
  onContinuousEditEnd?: () => void;
  videoParameters?: {
    controls: VideoSubmissionControlParams;
    render: (fields: ComfyVideoParameterFields) => ReactNode;
  };
}

function getComfyVideoParameterSemantic(field: ComfyWorkflowParameter): CloudWorkflowParameterSemantic {
  if (field.type === 'boolean' || /load(video|image)|videoload|slice|trim|cut|crop/i.test(field.classType)) return 'other';
  // 这类工作流把秒数放在 Primitive 的 value 里，含义写在节点标题上。
  if (field.fieldName === 'value' && typeof field.defaultValue === 'number'
    && /^Primitive(Float|Int)$/i.test(field.classType) && /duration|时长|秒/i.test(field.label.split(' · ')[0])) return 'duration';
  return getCloudWorkflowParameterSemantic(field.fieldName, field.label);
}

/** 云参数沿用原键；本地只存字段覆盖值，节点声明留在内存并绑定当前服务器。 */
export default function CloudWorkflowParamSelector({ workflow, values = {}, onChange, disabled, onContinuousEditEnd, videoParameters }: CloudWorkflowParamSelectorProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const local = !workflow.adapterType || workflow.adapterType === 'comfyui';
  const title = t(local ? 'ComfyUI 工作流参数' : '云工作流参数');
  const serverAddress = useAppStore((state) => !local ? '' : workflow.serverId
    ? state.config.comfyServers?.find((server) => server.id === workflow.serverId)?.url ?? '' : state.config.comfyUIUrl ?? '');
  const [reload, setReload] = useState(0);
  const [localState, setLocalState] = useState<{
    workflow?: WorkflowDefinition;
    address?: string;
    reload?: number;
    fields: ComfyWorkflowParameter[];
    specs?: Map<string, Record<string, ComfyInputSpec>>;
    error?: string;
  }>({ fields: [] });
  const currentLocal = localState.workflow === workflow && localState.address === serverAddress && localState.reload === reload;
  const localFields = currentLocal ? localState.fields : [];
  const localLoading = local && open && !currentLocal;
  const localError = currentLocal ? localState.error : undefined;
  useEffect(() => {
    if (!open || !local) return;
    let active = true;
    void (async () => {
      try {
        const baseUrl = comfyBaseUrlFor(workflow.id);
        if (!baseUrl) throw new Error(t('请先配置或启动此工作流的 ComfyUI 服务'));
        const specs = new Map<string, Record<string, ComfyInputSpec>>();
        const fields = await loadComfyWorkflowParameters(workflow, async (classType) => {
          const inputs = await fetchNodeInputSpecs(baseUrl, classType, reload > 0);
          if (inputs) specs.set(classType, inputs);
          return inputs;
        });
        if (active) setLocalState({ workflow, address: serverAddress, reload, fields, specs });
      } catch (error) {
        if (active) setLocalState({ workflow, address: serverAddress, reload, fields: [],
          error: error instanceof Error ? error.message : t('读取工作流参数失败') });
      }
    })();
    return () => { active = false; };
  }, [open, local, workflow, serverAddress, reload, t]);
  const manifest = workflow.workflowApi;
  const defaultPromptKey = workflow.runninghub?.inputBindingMode === 'nodes' ? workflow.defaultNodes?.prompt : undefined;
  const fields = workflow.adapterType === 'runninghub'
    ? resolveRunningHubParameters(workflow.runninghub?.parameters ?? []).filter((field) => field.source === 'value' && runningHubParameterKey(field) !== defaultPromptKey).map((field) => ({
      name: field.fieldName, label: field.label, keys: [runningHubParameterKey(field)], defaultValue: String(field.defaultValue),
      value: values[runningHubParameterKey(field)] ?? String(field.defaultValue),
    }))
    : manifest?.version === 2 ? Object.entries(manifest.parameters).map(([name, field]) => ({
      name, label: field.label || name, keys: [`workflow::${name}`, name], defaultValue: String(field.default ?? ''),
      value: values[`workflow::${name}`] ?? values[name] ?? String(field.default ?? ''),
    })) : localFields.map((field) => ({ name: field.fieldName, label: field.label, keys: [comfyWorkflowParameterKey(field)], defaultValue: String(field.defaultValue),
      value: values[comfyWorkflowParameterKey(field)] ?? String(field.defaultValue) }));
  const changeParameters = (next: Record<string, string>) => {
    if (disabled) return;
    const changedKeys = new Set([...Object.keys(values), ...Object.keys(next)].filter((key) => values[key] !== next[key]));
    const ratios = fields.filter((field) => getCloudWorkflowParameterSemantic(field.name, field.label) === 'ratio');
    // 多个比例字段只跟随本次修改项；重选唯一的当前比例也能修正旧节点外框。
    const field = ratios.find((item) => item.keys.some((key) => changedKeys.has(key)))
      ?? (changedKeys.size === 0 && ratios.length === 1 ? ratios[0] : undefined);
    const raw = field?.keys.map((key) => Object.hasOwn(next, key) ? next[key] : undefined).find((value) => value !== undefined) ?? field?.defaultValue;
    const ratio = raw?.match(/^\s*(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)(?=\s|\(|$)/);
    const width = Number(ratio?.[1]);
    const height = Number(ratio?.[2]);
    const aspectRatio = [width, height, width / height].every((value) => Number.isFinite(value) && value > 0) ? `${width}:${height}` : undefined;
    // 保留提交用的完整枚举值，归一化比例仅用于同一次节点更新。
    onChange(next, aspectRatio);
  };
  const staleLocalKeys = local && currentLocal && !localError
    ? Object.keys(splitComfyWorkflowInputs(values).parameters).filter((key) => !localFields.some((field) => comfyWorkflowParameterKey(field) === key)) : [];
  const summary = fields.filter((field) => getCloudWorkflowParameterSemantic(field.name, field.label) !== 'other' && field.value !== '')
    .slice(0, 3).map((field) => getCloudWorkflowParameterSemantic(field.name, field.label) === 'duration'
      ? `${field.label} ${field.value}` : field.value).join(' · ');
  const embeddedVideo = local && Boolean(videoParameters);
  const triggerLabel = (!embeddedVideo && summary) || (local && !currentLocal ? t('参数') : t('参数 · {count} 项', { count: fields.length }));
  const { videoResolution, videoFps, videoFrames, seedanceRatio, seedanceDuration } = videoParameters?.controls ?? {};
  const localVideo = useMemo(() => {
    if (!open || !embeddedVideo || !currentLocal) return;
    const groups: Record<CloudWorkflowParameterSemantic, ComfyWorkflowParameter[]> = { ratio: [], resolution: [], duration: [], other: [] };
    for (const field of localState.fields) groups[getComfyVideoParameterSemantic(field)].push(field);
    if (!localState.specs || ![groups.ratio, groups.resolution, groups.duration].some((group) => group.length)) return { groups };

    const controls = resolveVideoSubmissionControls({ provider: 'comfyui', workflowId: workflow.id,
      videoResolution, videoFps, videoFrames, seedanceRatio, seedanceDuration });
    if (controls.videoResolution === undefined || controls.videoFps === undefined
      || controls.videoFrames === undefined || controls.seedanceDuration === undefined) return { groups };

    // 老节点可能存着通用尺寸和时长。用提交时的注入规则在副本上算出顶部字段的当前值。
    const graph = JSON.parse(workflow.fileContent) as Record<string, Record<string, unknown>>;
    injectVideoParamsIntoWorkflow(graph, controls.videoResolution, controls.seedanceRatio, controls.videoFps,
      controls.videoFrames, controls.seedanceDuration, localState.specs);
    for (const key of ['ratio', 'resolution', 'duration'] as const) {
      groups[key] = groups[key].map((field) => {
        const inputs = graph[field.nodeId]?.inputs as Record<string, unknown> | undefined;
        const value = inputs?.[field.fieldName];
        return typeof value === 'string' || typeof value === 'number' ? { ...field, defaultValue: value } : field;
      });
    }
    return { groups, size: estimateComfyH3VideoSize(graph, localState.fields, values) };
  }, [open, embeddedVideo, currentLocal, localState, workflow.id, workflow.fileContent,
    videoResolution, videoFps, videoFrames, seedanceRatio, seedanceDuration, values]);
  const localVideoFields = localVideo?.groups;
  const previewSize = localVideo?.size;
  const renderLocalFields = (parameters: ComfyWorkflowParameter[] | undefined) => parameters?.length
    ? <ComfyWorkflowParameterFields parameters={parameters} values={values} onChange={changeParameters} disabled={disabled} /> : null;
  const localHint = local && <p className="ui-hint mb-3">{t('显示工作流原值；此处修改的字段优先于通用尺寸设置。默认正文和参考素材仍使用对话框内容。')}</p>;
  const close = useCallback(() => {
    setOpen(false);
    onContinuousEditEnd?.();
  }, [onContinuousEditEnd, setOpen]);

  useEffect(() => {
    if (!open) return;
    const containsTarget = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return false;
      return triggerRef.current?.contains(target) || panelRef.current?.contains(target)
        || (target instanceof Element && Boolean(target.closest('[data-ui-select-portal]')));
    };
    const outside = (event: PointerEvent | FocusEvent) => {
      if (!containsTarget(event.target)) close();
    };
    const keydown = (event: KeyboardEvent) => {
      // 画布快捷键在 document 捕获；提前隔离浮层内的删除、数字键和撤销。
      // 不阻止默认动作或同层监听，输入与 Select 自身的键盘行为仍可使用。
      if (event.target instanceof Node && panelRef.current?.contains(event.target)
        && event.key !== 'F12' && !((event.ctrlKey || event.metaKey || event.altKey) && event.key.toLowerCase() === 's')) event.stopPropagation();
      // 下拉菜单先消费 Esc；第二次才关闭参数浮层。
      if (event.key !== 'Escape' || document.querySelector('[data-ui-select-portal]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    window.addEventListener('keydown', keydown, true);
    // 画布移动只改变锚点位置，不触发 DOM resize/scroll；Portal 应与宿主一起收起。
    const interactionObserver = new MutationObserver(() => {
      if (document.documentElement.classList.contains('canvas-interacting')) close();
    });
    interactionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      interactionObserver.disconnect();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('keydown', keydown, true);
    };
  }, [open, close]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (!open || !panel || !trigger) return;
    const position = () => {
      const rect = trigger.getBoundingClientRect();
      const available = Math.max(rect.top - 14, window.innerHeight - rect.bottom - 14, 0);
      panel.style.maxHeight = `${Math.min(560, available)}px`;
      let layer = 300;
      for (let parent: HTMLElement | null = trigger; parent; parent = parent.parentElement) {
        const current = Number.parseInt(window.getComputedStyle(parent).zIndex, 10);
        if (Number.isFinite(current)) layer = Math.max(layer, current + 1);
      }
      panel.style.zIndex = String(layer);
      const next = calcAnchoredPosition({ left: rect.right - panel.offsetWidth, top: rect.top, bottom: rect.bottom }, panel.offsetWidth, panel.offsetHeight, 6);
      panel.style.left = `${next.left}px`;
      panel.style.top = `${next.top}px`;
      panel.dataset.placement = next.placement;
    };
    position();
    panel.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(panel);
    observer.observe(trigger);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open]);

  return <div className="ui-schema-renderer min-w-0" data-ui-schema-placement="cloudWorkflowParams">
    <AnimatedButton ref={triggerRef} type="button" className="img-pill-btn ui-schema-menu-trigger max-w-64"
      aria-label={title} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      title={`${title} · ${triggerLabel}`}
      onClick={(event) => { event.stopPropagation(); if (open) close(); else setOpen(true); }}>
      <Icon icon="lucide:sliders-horizontal" width={14} className="shrink-0" />
      <span className="ui-schema-pill-label truncate">{triggerLabel}</span>
    </AnimatedButton>
    {open && createPortal(<div ref={panelRef} id={panelId} role="dialog" tabIndex={-1}
      aria-label={title} data-cloud-workflow-parameters=""
      className="img-ratio-popup ui-schema-popup cloud-workflow-params nodrag nowheel"
      onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onBlurCapture={() => onContinuousEditEnd?.()}>
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-canvas-border pb-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-canvas-text">{title}</div>
          <div className="mt-1 truncate text-xs text-canvas-text-muted" title={workflow.name}>{workflow.name}</div>
        </div>
        <button type="button" className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost shrink-0" aria-label={t('关闭参数')}
          onClick={() => { close(); triggerRef.current?.focus({ preventScroll: true }); }}>
          <Icon icon="lucide:x" width={14} />
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain pr-1">
        {!embeddedVideo && localHint}
        {localLoading && <p className="ui-hint flex items-center gap-2" role="status"><span className="ui-spinner" />{t('正在读取 ComfyUI 参数声明…')}</p>}
        {localError && <div className="ui-alert ui-alert--danger flex-wrap" role="alert"><span>{localError}</span>
          <button type="button" className="ui-btn ui-btn--sm" onClick={() => setReload((value) => value + 1)}>{t('重试')}</button></div>}
        {previewSize && <p className="ui-hint mb-2 tabular-nums" role="status">{t('预计生成尺寸 {width} × {height}', previewSize)}</p>}
        {localVideoFields && videoParameters?.render({
          ratio: renderLocalFields(localVideoFields.ratio),
          resolution: renderLocalFields(localVideoFields.resolution),
          duration: renderLocalFields(localVideoFields.duration),
        })}
        {embeddedVideo && localHint}
        {staleLocalKeys.length > 0 && <div className="ui-alert ui-alert--warning mb-3 flex-wrap" role="alert">
          <span>{t('部分参数已失效，请清除后重新设置。')}</span><button type="button" className="ui-btn ui-btn--sm" disabled={disabled} onClick={() => {
            const next = { ...values }; for (const key of staleLocalKeys) delete next[key]; onChange(next);
          }}>{t('清除失效参数')}</button></div>}
        {workflow.adapterType === 'runninghub' ? <RunningHubParameterFields appearance="popover"
          parameters={workflow.runninghub?.parameters ?? []} defaultPromptKey={defaultPromptKey} values={values} onChange={changeParameters} disabled={disabled} />
          : manifest?.version === 2 ? <WorkflowApiParameterFields appearance="popover" manifest={manifest}
            values={values} onChange={changeParameters} disabled={disabled} /> : local && !localLoading && !localError
              ? renderLocalFields(localVideoFields ? localVideoFields.other : localFields) : null}
        {fields.length === 0 && !localLoading && !localError && <p className="text-xs text-canvas-text-muted">{t('此工作流没有额外可调参数')}</p>}
      </div>
    </div>, document.body)}
  </div>;
}
