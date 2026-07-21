/**
 * ProjectSettingsPopover — 当前项目的创作基线设置弹层。
 */
import { Icon } from '@iconify/react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import type {
  AppConfig,
  CanvasProject,
  NodeType,
  ProjectModelKind,
  ProjectSettings,
} from '../types';
import { useAppStore } from '../store/useAppStore';
import {
  getConfiguredModelGroups,
  isProviderCategoryVisible,
} from './nodes/shared/defaultModels';
import StyleSelector from './nodes/shared/StyleSelector';
import PopupCloseButton from './shared/PopupCloseButton';
import {
  PROJECT_IMAGE_ASPECT_RATIOS,
  PROJECT_IMAGE_SIZES,
  PROJECT_STYLE_OPTIONS,
  PROJECT_VIDEO_DURATIONS,
  PROJECT_VIDEO_RESOLUTIONS,
} from '../services/projectSettingsService';
import { uploadSourceFileToProject } from '../services/fileService';

interface ProjectSettingsPopoverProps {
  isOpen: boolean;
  project: CanvasProject | null;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

interface ModelRowDefinition {
  kind: ProjectModelKind;
  label: string;
  nodeType: NodeType;
  icon: string;
  colorClass: string;
  tabActiveClass: string;
}

interface ModelOptionGroup {
  id: string;
  name: string;
  options: Array<{ value: string; label: string }>;
}

const MODEL_ROWS: ModelRowDefinition[] = [
  {
    kind: 'text', label: '文本', nodeType: 'ai-text', icon: 'lucide:type',
    colorClass: 'text-indigo-400',
    tabActiveClass: 'bg-node-text/15 text-node-text-light ring-1 ring-inset ring-node-text/25',
  },
  {
    kind: 'image', label: '图像', nodeType: 'ai-image', icon: 'lucide:image',
    colorClass: 'text-green-400',
    tabActiveClass: 'bg-node-image/15 text-node-image-light ring-1 ring-inset ring-node-image/25',
  },
  {
    kind: 'video', label: '视频', nodeType: 'ai-video', icon: 'lucide:clapperboard',
    colorClass: 'text-blue-400',
    tabActiveClass: 'bg-node-video/15 text-node-video-light ring-1 ring-inset ring-node-video/25',
  },
  {
    kind: 'audio', label: '音频', nodeType: 'ai-audio', icon: 'lucide:audio-lines',
    colorClass: 'text-orange-400',
    tabActiveClass: 'bg-node-audio/15 text-node-audio-light ring-1 ring-inset ring-node-audio/25',
  },
];

function cloneSettings(settings: ProjectSettings | undefined): ProjectSettings {
  const legacyPromptSuffix = settings?.promptSuffix ?? '';
  const vs = settings?.visualStyle;
  return {
    visualStyle: vs
      ? {
          ...vs,
          styleReference: vs.styleReference ? { ...vs.styleReference } : undefined,
        }
      : undefined,
    promptSuffixes: Object.fromEntries(MODEL_ROWS.map((row) => [
      row.kind,
      settings?.promptSuffixes?.[row.kind] ?? legacyPromptSuffix,
    ])),
    defaultModels: { ...settings?.defaultModels },
    generation: { ...settings?.generation },
  };
}

function buildModelGroups(
  row: ModelRowDefinition,
  config: AppConfig,
): ModelOptionGroup[] {
  const seen = new Set<string>();
  const groups = getConfiguredModelGroups(config, row.nodeType).flatMap((group) => {
    const options = group.models.flatMap((model) => {
      if (
        model.provider === 'runninghubwf'
        || !model.nodeTypes.includes(row.nodeType)
        || seen.has(model.value)
      ) return [];
      seen.add(model.value);
      return [{ value: model.value, label: model.label }];
    });
    return options.length > 0 ? [{ id: group.id, name: group.name, options }] : [];
  });

  const generalOptions = (config.generalModels ?? []).flatMap((model) => {
    if (
      model.category !== row.kind
      || !isProviderCategoryVisible(config, model.providerConfigId, model.category)
    ) return [];
    const value = `general/${model.id}`;
    if (seen.has(value)) return [];
    seen.add(value);
    return [{ value, label: model.name }];
  });
  if (generalOptions.length > 0) {
    groups.push({ id: 'general-models', name: '通用模型', options: generalOptions });
  }
  return groups;
}

function SectionTitle({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold text-canvas-text-secondary">
      <Icon icon={icon} className="h-3.5 w-3.5" />
      <span>{children}</span>
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-[11px] font-medium text-canvas-text-muted">{label}</span>
      <span className="relative">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 w-full appearance-none rounded-md border border-canvas-border bg-canvas-card
                     px-3 pr-8 text-xs text-canvas-text outline-none transition-colors
                     hover:border-border-secondary focus:border-indigo-500"
        >
          {children}
        </select>
        <Icon
          icon="lucide:chevron-down"
          aria-hidden="true"
          className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5
                     -translate-y-1/2 text-canvas-text-muted"
        />
      </span>
    </label>
  );
}

export default function ProjectSettingsPopover({
  isOpen,
  project,
  anchorRef,
  onClose,
}: ProjectSettingsPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const [draft, setDraft] = useState<ProjectSettings>(() => cloneSettings(project?.settings));
  const [activePromptKind, setActivePromptKind] = useState<ProjectModelKind>('image');
  const [saving, setSaving] = useState(false);
  const [position, setPosition] = useState({ top: 44, left: 12 });
  const nestedModalOpenRef = useRef(false);
  const { config, customStyles, updateProjectSettings } = useAppStore(
    useShallow((state) => ({
      config: state.config,
      customStyles: state.customStyles,
      updateProjectSettings: state.updateProjectSettings,
    })),
  );

  useLayoutEffect(() => {
    if (!isOpen) return;
    const updatePosition = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const panelWidth = Math.min(420, window.innerWidth - 24);
      setPosition({
        top: anchor.bottom + 8,
        left: Math.max(12, Math.min(anchor.right - panelWidth, window.innerWidth - panelWidth - 12)),
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorRef, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFrame = requestAnimationFrame(() => panelRef.current?.focus());
    const handlePointerDown = (event: PointerEvent) => {
      if (nestedModalOpenRef.current) return;
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (nestedModalOpenRef.current) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [anchorRef, isOpen, onClose]);

  const handleStyleModalOpenChange = useCallback((open: boolean) => {
    nestedModalOpenRef.current = open;
  }, []);

  const styleOptions = useMemo(() => {
    const options = new Map(PROJECT_STYLE_OPTIONS.map((style) => [style.id, style]));
    for (const style of customStyles) {
      if (!options.has(style.id)) {
        options.set(style.id, {
          id: style.id,
          name: style.name,
          description: style.prompt,
          prompt: style.prompt,
        });
      }
    }
    return [...options.values()];
  }, [customStyles]);

  const modelGroups = useMemo(() => Object.fromEntries(
    MODEL_ROWS.map((row) => [row.kind, buildModelGroups(row, config)]),
  ) as Record<ProjectModelKind, ModelOptionGroup[]>, [config]);
  const activePromptRow = MODEL_ROWS.find((row) => row.kind === activePromptKind) ?? MODEL_ROWS[0];

  const handleStyleChange = (styleId: string) => {
    const style = styleOptions.find((option) => option.id === styleId);
    setDraft((current) => ({
      ...current,
      visualStyle: style
        ? {
            styleId: style.id,
            styleName: style.name,
            prompt: style.prompt,
            locked: current.visualStyle?.locked ?? false,
            // 保留已上传的风格母图
            styleReference: current.visualStyle?.styleReference,
          }
        : current.visualStyle?.styleReference
          ? {
              styleReference: current.visualStyle.styleReference,
              locked: current.visualStyle.locked,
            }
          : undefined,
    }));
  };

  const [styleRefBusy, setStyleRefBusy] = useState(false);

  const handleUploadStyleReference = async () => {
    if (!project || styleRefBusy) return;
    setStyleRefBusy(true);
    try {
      const uploaded = await uploadSourceFileToProject(
        'png,jpg,jpeg,webp,gif,bmp',
        project.id,
      );
      if (!uploaded) return;
      setDraft((current) => ({
        ...current,
        visualStyle: {
          ...current.visualStyle,
          styleReference: {
            imageUrl: uploaded.dataUrl,
            filePath: uploaded.filePath,
            fileName: uploaded.fileName,
            enabled: true,
          },
        },
      }));
    } catch (err) {
      console.error('[项目设置] 上传风格母图失败:', err);
      useAppStore.getState().showToast?.(
        err instanceof Error ? err.message : '上传风格母图失败',
        'error',
      );
    } finally {
      setStyleRefBusy(false);
    }
  };

  const handleClearStyleReference = () => {
    setDraft((current) => {
      if (!current.visualStyle) return current;
      const { styleReference: _r, ...rest } = current.visualStyle;
      const nextVs = { ...rest };
      // 若既无枚举画风也无母图，清空 visualStyle
      if (!nextVs.styleId && !nextVs.prompt) {
        return { ...current, visualStyle: undefined };
      }
      return { ...current, visualStyle: nextVs };
    });
  };

  const handleToggleStyleReference = () => {
    setDraft((current) => {
      const ref = current.visualStyle?.styleReference;
      if (!ref?.imageUrl && !ref?.filePath) return current;
      return {
        ...current,
        visualStyle: {
          ...current.visualStyle,
          styleReference: {
            ...ref,
            enabled: ref.enabled === false,
          },
        },
      };
    });
  };

  const handleModelChange = (kind: ProjectModelKind, model: string) => {
    setDraft((current) => ({
      ...current,
      defaultModels: { ...current.defaultModels, [kind]: model || undefined },
    }));
  };

  const handleGenerationChange = (
    key: 'imageAspectRatio' | 'imageSize' | 'videoResolution' | 'videoDuration',
    value: string | number | undefined,
  ) => {
    setDraft((current) => ({
      ...current,
      generation: { ...current.generation, [key]: value },
    }));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !project) return;
    setSaving(true);
    const saved = await updateProjectSettings(draft);
    setSaving(false);
    if (saved) onClose();
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {isOpen && project ? (
        <motion.div
          id="project-settings-popover"
          ref={panelRef}
          role="dialog"
          aria-label={`${project.name} 项目设置`}
          tabIndex={-1}
          style={{ top: position.top, left: position.left }}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -6 }}
          transition={reduceMotion
            ? { duration: 0.12 }
            : { type: 'spring', bounce: 0, duration: 0.32 }}
          className="fixed z-[200] flex max-h-[min(78vh,680px)] w-[min(420px,calc(100vw-24px))]
                     origin-top-right flex-col overflow-hidden rounded-lg border border-[var(--glass-ring)]
                     bg-[var(--glass-bg)] text-canvas-text shadow-2xl shadow-black/40
                     outline-none backdrop-blur-2xl backdrop-saturate-150"
        >
          <form onSubmit={(event) => { void handleSubmit(event); }} className="flex min-h-0 flex-col">
            <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border-subtle px-4">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-indigo-500/15 text-indigo-400">
                <Icon icon="lucide:sliders-horizontal" className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold leading-5">项目设置</h2>
                <p className="truncate text-[11px] leading-4 text-canvas-text-muted">{project.name}</p>
              </div>
              <PopupCloseButton ariaLabel="关闭项目设置" onClick={onClose} />
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
              <section className="grid gap-3 px-4 py-4">
                <SectionTitle icon="lucide:palette">创作基线</SectionTitle>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
                  <div className="grid gap-1.5">
                    <span className="text-[11px] font-medium text-canvas-text-muted">整体画风（文字预设）</span>
                    <StyleSelector
                      nodeType="ai-image"
                      selectedStyle={draft.visualStyle?.styleId}
                      selectedStyleName={draft.visualStyle?.styleName}
                      onChange={handleStyleChange}
                      triggerVariant="field"
                      respectProjectLock={false}
                      onModalOpenChange={handleStyleModalOpenChange}
                    />
                  </div>
                  <div className="grid h-9 grid-cols-[auto_auto] items-center gap-2 text-[11px] text-canvas-text-secondary">
                    <span>锁定</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={draft.visualStyle?.locked === true}
                      disabled={!draft.visualStyle?.styleId}
                      onClick={() => setDraft((current) => ({
                        ...current,
                        visualStyle: current.visualStyle
                          ? { ...current.visualStyle, locked: !current.visualStyle.locked }
                          : undefined,
                      }))}
                      className={`relative h-5 w-9 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        draft.visualStyle?.locked ? 'bg-indigo-500' : 'bg-canvas-border'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                          draft.visualStyle?.locked ? 'translate-x-[18px]' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* 风格母图：上传后本项目图像生成自动跟随，无需每次 @ */}
                <div className="grid gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-[11px] font-medium text-canvas-text">风格母图</span>
                      <p className="mt-0.5 text-[10px] leading-relaxed text-canvas-text-muted">
                        上传卡通/电影截图等。本项目所有图像生成会自动参考此风格，无需每次 @。
                      </p>
                    </div>
                    {draft.visualStyle?.styleReference?.imageUrl ? (
                      <div className="grid h-9 shrink-0 grid-cols-[auto_auto] items-center gap-2 text-[11px] text-canvas-text-secondary">
                        <span>启用</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={draft.visualStyle.styleReference.enabled !== false}
                          onClick={handleToggleStyleReference}
                          className={`relative h-5 w-9 rounded-full transition-colors ${
                            draft.visualStyle.styleReference.enabled !== false
                              ? 'bg-indigo-500'
                              : 'bg-canvas-border'
                          }`}
                        >
                          <span
                            aria-hidden="true"
                            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                              draft.visualStyle.styleReference.enabled !== false
                                ? 'translate-x-[18px]'
                                : 'translate-x-0.5'
                            }`}
                          />
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {draft.visualStyle?.styleReference?.imageUrl ? (
                    <div className="flex items-center gap-3">
                      <div className="h-16 w-16 shrink-0 overflow-hidden rounded-md border border-canvas-border bg-canvas-bg">
                        <img
                          src={draft.visualStyle.styleReference.imageUrl}
                          alt="风格母图"
                          className="h-full w-full object-cover"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[11px] text-canvas-text-secondary">
                          {draft.visualStyle.styleReference.fileName || '已设置风格母图'}
                        </p>
                        <p className="mt-0.5 text-[10px] text-canvas-text-muted">
                          {draft.visualStyle.styleReference.enabled === false
                            ? '已关闭：生成时不注入'
                            : '已启用：生图自动带上'}
                        </p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            disabled={styleRefBusy}
                            onClick={() => { void handleUploadStyleReference(); }}
                            className="rounded-md px-2 py-1 text-[11px] text-indigo-300 hover:bg-indigo-500/15 disabled:opacity-50"
                          >
                            更换
                          </button>
                          <button
                            type="button"
                            onClick={handleClearStyleReference}
                            className="rounded-md px-2 py-1 text-[11px] text-red-400/80 hover:bg-red-500/10"
                          >
                            清除
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={styleRefBusy || !project}
                      onClick={() => { void handleUploadStyleReference(); }}
                      className="flex h-11 items-center justify-center gap-2 rounded-md border border-dashed
                                 border-white/[0.12] text-[12px] text-canvas-text-secondary
                                 transition-colors hover:border-indigo-500/40 hover:bg-indigo-500/5
                                 hover:text-indigo-300 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Icon icon="lucide:image-plus" className="h-4 w-4" />
                      {styleRefBusy ? '上传中…' : '上传风格母图'}
                    </button>
                  )}
                </div>
                <div className="grid gap-1.5">
                  <span className="flex items-center justify-between gap-3">
                    <span className="text-[11px] font-medium text-canvas-text-muted">项目提示词后缀</span>
                    <span
                      role="tablist"
                      aria-label="提示词后缀节点类型"
                      className="flex h-7 items-center gap-0.5 rounded-md bg-canvas-card p-0.5"
                    >
                      {MODEL_ROWS.map((row) => (
                        <button
                          key={row.kind}
                          type="button"
                          role="tab"
                          aria-selected={activePromptKind === row.kind}
                          onClick={() => setActivePromptKind(row.kind)}
                          className={`h-6 min-w-10 rounded px-2 text-[10px] font-medium
                                      transition-[color,background-color,box-shadow] ${
                            activePromptKind === row.kind
                              ? row.tabActiveClass
                              : 'text-canvas-text-muted hover:text-canvas-text-secondary'
                          }`}
                        >
                          {row.label}
                        </button>
                      ))}
                    </span>
                  </span>
                  <textarea
                    value={draft.promptSuffixes?.[activePromptKind] ?? ''}
                    maxLength={2000}
                    rows={3}
                    aria-label={`${activePromptRow.label}节点提示词后缀`}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      promptSuffixes: {
                        ...current.promptSuffixes,
                        [activePromptKind]: event.target.value,
                      },
                    }))}
                    className="min-h-20 resize-y rounded-md border border-canvas-border bg-canvas-card px-3 py-2
                               text-xs leading-5 text-canvas-text outline-none transition-colors
                               placeholder:text-canvas-text-muted/60 hover:border-border-secondary
                               focus:border-indigo-500"
                    placeholder={`${activePromptRow.label}节点的一致性约束`}
                  />
                </div>
              </section>

              <section className="grid gap-3 border-t border-border-subtle px-4 py-4">
                <SectionTitle icon="lucide:cpu">默认模型</SectionTitle>
                <div className="grid gap-2">
                  {MODEL_ROWS.map((row) => {
                    const selectedModel = draft.defaultModels?.[row.kind] ?? '';
                    const selectedModelVisible = !selectedModel || modelGroups[row.kind].some((group) =>
                      group.options.some((option) => option.value === selectedModel),
                    );
                    return (
                      <label key={row.kind} className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-3">
                        <span className="flex items-center gap-2 text-xs text-canvas-text-secondary">
                          <Icon icon={row.icon} className={`h-3.5 w-3.5 ${row.colorClass}`} />
                          {row.label}
                        </span>
                        <span className="relative">
                          <select
                            value={selectedModel}
                            onChange={(event) => handleModelChange(row.kind, event.target.value)}
                            className="h-9 w-full appearance-none rounded-md border border-canvas-border
                                       bg-canvas-card px-3 pr-8 text-xs text-canvas-text outline-none
                                       transition-colors hover:border-border-secondary focus:border-indigo-500"
                          >
                            <option value="">跟随应用默认</option>
                            {!selectedModelVisible && (
                              <option value={selectedModel} disabled>已隐藏 · {selectedModel}</option>
                            )}
                            {modelGroups[row.kind].map((group) => (
                              <optgroup key={group.id} label={group.name}>
                                {group.options.map((option) => (
                                  <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                          <Icon
                            icon="lucide:chevron-down"
                            aria-hidden="true"
                            className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5
                                       -translate-y-1/2 text-canvas-text-muted"
                          />
                        </span>
                      </label>
                    );
                  })}
                </div>
              </section>

              <section className="grid gap-3 border-t border-border-subtle px-4 py-4">
                <SectionTitle icon="lucide:scan">输出默认</SectionTitle>
                <div className="grid grid-cols-2 gap-3">
                  <SelectField
                    label="图片比例"
                    value={draft.generation?.imageAspectRatio ?? ''}
                    onChange={(value) => handleGenerationChange('imageAspectRatio', value || undefined)}
                  >
                    <option value="">跟随节点</option>
                    {PROJECT_IMAGE_ASPECT_RATIOS.map((ratio) => (
                      <option key={ratio} value={ratio}>{ratio}</option>
                    ))}
                  </SelectField>
                  <SelectField
                    label="图片画质"
                    value={draft.generation?.imageSize ?? ''}
                    onChange={(value) => handleGenerationChange('imageSize', value || undefined)}
                  >
                    <option value="">跟随节点</option>
                    {PROJECT_IMAGE_SIZES.map((size) => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </SelectField>
                  <SelectField
                    label="视频分辨率"
                    value={draft.generation?.videoResolution ?? ''}
                    onChange={(value) => handleGenerationChange('videoResolution', value || undefined)}
                  >
                    <option value="">跟随节点</option>
                    {PROJECT_VIDEO_RESOLUTIONS.map((resolution) => (
                      <option key={resolution} value={resolution}>{resolution}</option>
                    ))}
                  </SelectField>
                  <SelectField
                    label="视频时长"
                    value={draft.generation?.videoDuration?.toString() ?? ''}
                    onChange={(value) => handleGenerationChange(
                      'videoDuration',
                      value ? Number(value) : undefined,
                    )}
                  >
                    <option value="">跟随节点</option>
                    {PROJECT_VIDEO_DURATIONS.map((duration) => (
                      <option key={duration} value={duration}>{duration} 秒</option>
                    ))}
                  </SelectField>
                </div>
              </section>
            </div>

            <footer className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-border-subtle px-4">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="h-8 rounded-md px-3 text-xs font-medium text-canvas-text-secondary
                           transition-colors hover:bg-canvas-hover hover:text-canvas-text disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex h-8 items-center gap-1.5 rounded-md bg-indigo-500 px-3 text-xs font-medium
                           text-white shadow-sm shadow-black/20 transition-[background-color,opacity,transform]
                           hover:bg-indigo-400 active:scale-[0.98] disabled:cursor-wait disabled:opacity-60"
              >
                {saving ? <Icon icon="lucide:loader-circle" className="h-3.5 w-3.5 animate-spin" /> : null}
                保存
              </button>
            </footer>
          </form>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
