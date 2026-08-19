/**
 * PromptPanel 提示词面板 — AI 生成节点的核心输入面板，集成模型选择器、提示词编辑器、质量/比例/视频参数、生成按钮、/ 指令菜单
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import type {
  AnimationAction,
  CameraAperture,
  CameraExposureTime,
  CameraGenerationSettings,
  CameraLens,
  CameraShutterEffect,
  ImagePostProcess,
  ModelOption,
  NodeType,
  UserPreset,
  UserSkill,
  WorkflowDefinition,
} from '../../../types';
import { ANIMATION_ACTION_LABELS } from '../../../types';
import type { PresetOverride } from './SlashCommandMenu';
import { useAppStore } from '../../../store/useAppStore';
import ModelSelector from './ModelSelector';
import QualityRatioSelector from './QualityRatioSelector';
import VideoParamSelector from './VideoParamSelector';
import AudioParamSelector from './AudioParamSelector';
import StyleSelector from './StyleSelector';
import MentionEditor, { type MentionEditorHandle } from './MentionEditor';
import SlashCommandMenu from './SlashCommandMenu';
import PresetManager from './PresetManager';
import SkillManager from './SkillManager';
import { expandSkillReferences } from '../../../services/skillPromptService';
import { MAX_IMAGE_BATCH_COUNT } from '../../../types/aiTypes';
import type { AudioOutputFormat, AudioTtsVoice, VideoReferenceItem } from '../../../types/aiTypes';
import type { AudioGenerationPurpose } from '../../../types/media';

const ANIMATION_ACTIONS: AnimationAction[] = ['idle', 'walk', 'run', 'jump', 'attack', 'hit'];
const IMAGE_BATCH_COUNTS = Array.from({ length: MAX_IMAGE_BATCH_COUNT - 1 }, (_, index) => index + 2);
const BATCH_LONG_PRESS_MS = 450;

const CAMERA_LENS_OPTIONS: Array<{ value: CameraLens; label: string }> = [
  { value: '15mm', label: '15mm 超广角' },
  { value: '24mm', label: '24mm 广角' },
  { value: '35mm', label: '35mm 电影感' },
  { value: '50mm', label: '50mm 标准' },
  { value: '85mm', label: '85mm 人像' },
  { value: '200mm', label: '200mm 长焦' },
  { value: 'macro', label: '100mm 微距' },
  { value: 'fisheye', label: '鱼眼' },
];
const CAMERA_SHUTTER_OPTIONS: Array<{ value: CameraShutterEffect; label: string }> = [
  { value: 'freeze', label: '凝固动作' },
  { value: 'natural', label: '自然动态' },
  { value: 'motion', label: '动态拖影' },
  { value: 'light-trails', label: '光轨效果' },
];
const CAMERA_APERTURE_OPTIONS: CameraAperture[] = ['f/1.4', 'f/2', 'f/2.8', 'f/4', 'f/5.6', 'f/8', 'f/11', 'f/16'];
const CAMERA_EXPOSURE_OPTIONS: CameraExposureTime[] = ['1/2000s', '1/1000s', '1/500s', '1/250s', '1/125s', '1/60s', '1/30s', '1/8s', '1/2s', '1s', '5s'];

function CameraSettingsPreview({ settings }: { settings: CameraGenerationSettings }) {
  const lens = settings.lens;
  const macro = lens === 'macro';
  const subjectScale = lens === '15mm' ? 0.66
    : lens === '24mm' ? 0.76
      : lens === '35mm' ? 0.88
        : lens === '50mm' ? 1
          : lens === '85mm' ? 1.18
            : lens === '200mm' ? 1.38
              : macro ? 1.55
              : 0.92;
  const apertureNumber = settings.aperture ? Number(settings.aperture.slice(2)) : 5.6;
  const backgroundBlur = apertureNumber <= 1.4 ? 8
    : apertureNumber <= 2 ? 6.5
      : apertureNumber <= 2.8 ? 5
        : apertureNumber <= 4 ? 3.2
          : apertureNumber <= 5.6 ? 1.5
            : apertureNumber <= 8 ? 0.7
              : apertureNumber <= 11 ? 0.25
                : 0;
  const bokehRadius = apertureNumber <= 1.4 ? 14
    : apertureNumber <= 2 ? 11
      : apertureNumber <= 2.8 ? 9
        : apertureNumber <= 4 ? 7
          : apertureNumber <= 5.6 ? 5
            : 3;
  const bokehOpacity = apertureNumber <= 2.8 ? 0.72 : apertureNumber <= 5.6 ? 0.58 : 0.42;
  const exposureBrightness = settings.exposureTime === '5s' ? 1.28
    : settings.exposureTime === '1s' ? 1.2
      : settings.exposureTime === '1/2s' ? 1.13
        : settings.exposureTime === '1/8s' ? 1.06
          : settings.exposureTime === '1/2000s' ? 0.68
            : settings.exposureTime === '1/1000s' ? 0.76
              : settings.exposureTime === '1/500s' ? 0.84
                : 1;
  const motionCopies = macro ? []
    : settings.shutterEffect === 'light-trails' ? [42, 28, 14]
      : settings.shutterEffect === 'motion' ? [24, 12]
        : [];
  const fisheye = lens === 'fisheye';

  return (
    <svg viewBox="0 0 400 168" className="h-full w-full" fill="none" aria-label="摄影参数综合成像预览" role="img">
      <defs>
        <linearGradient id="camera-preview-sky" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#312e81" />
          <stop offset="1" stopColor="#111827" />
        </linearGradient>
        <linearGradient id="camera-preview-ground" x1="0" y1="0" x2="1" y2="0">
          <stop stopColor="#111827" />
          <stop offset=".5" stopColor="#312e81" />
          <stop offset="1" stopColor="#111827" />
        </linearGradient>
        <filter id="camera-preview-background-blur">
          <feGaussianBlur stdDeviation={macro ? Math.max(6, backgroundBlur) : backgroundBlur} />
        </filter>
        <clipPath id="camera-preview-clip"><rect width="400" height="168" rx="10" /></clipPath>
      </defs>
      <g clipPath="url(#camera-preview-clip)">
        <rect width="400" height="168" fill="url(#camera-preview-sky)" />
        <g filter="url(#camera-preview-background-blur)" opacity=".9">
          <circle cx="70" cy="43" r="19" fill="#fbbf24" opacity=".72" />
          <path d={fisheye ? 'M-18 117Q200 52 418 117V174H-18Z' : 'M-10 113 63 54l58 50 65-69 79 73 49-43 96 50v59H-10Z'} fill="#172554" />
          <path d={fisheye ? 'M-20 135Q200 94 420 135V174H-20Z' : 'M-10 130 88 90l67 36 78-48 82 48 95-30v78H-10Z'} fill="#1e1b4b" />
          <g stroke="#818cf8" strokeWidth="1" opacity=".52">
            <path d="M22 126V88h34v38M74 126V99h28v27M292 126V84h38v42M345 126V96h31v30" />
            <path d="M29 96h8m7 0h7m30 11h14m204-14h8m8 0h8m29 11h17M29 108h8m7 0h7m248-3h8m8 0h8" />
          </g>
          <rect y="130" width="400" height="38" fill="url(#camera-preview-ground)" />
          <path d="M0 145h400M56 130l-25 38m313-38 25 38" stroke="#6366f1" strokeWidth="1" opacity=".55" />
          {[34, 98, 302, 360].map((x) => <circle key={x} cx={x} cy="116" r={bokehRadius} fill="#fbbf24" opacity={bokehOpacity} />)}
        </g>
        {(settings.shutterEffect === 'motion' || settings.shutterEffect === 'light-trails') && (
          <g strokeLinecap="round">
            <path d="M18 119h126" stroke="#22d3ee" strokeWidth="3" opacity=".5" />
            <path d="M258 106h124" stroke="#f472b6" strokeWidth="4" opacity=".5" />
            {settings.shutterEffect === 'light-trails' && <path d="M8 137c88-34 204 31 384-18" stroke="#fde047" strokeWidth="3" opacity=".62" />}
          </g>
        )}
        {motionCopies.map((offset, index) => (
          <g key={offset} transform={`translate(${offset} 0) translate(200 105) scale(${subjectScale}) translate(-200 -105)`} fill="#a5b4fc" opacity={0.08 + index * 0.05}>
            <circle cx="200" cy="70" r="17" />
            <path d="M169 151c2-43 12-66 31-66s29 23 31 66h-62Z" />
          </g>
        ))}
        {macro ? (
          <g transform="translate(200 101)">
            {[0, 60, 120, 180, 240, 300].map((angle) => (
              <ellipse key={angle} cx="0" cy="-27" rx="18" ry="35" fill="#c4b5fd" opacity=".9" transform={`rotate(${angle})`} />
            ))}
            <circle r="24" fill="#fde047" />
            <circle r="10" fill="#f59e0b" />
            <path d="M0 23c-4 31 5 43 18 61" stroke="#4ade80" strokeWidth="6" strokeLinecap="round" />
            <path d="M9 54c18-13 31-10 38 0-17 8-29 8-38 0Z" fill="#4ade80" opacity=".85" />
          </g>
        ) : (
          <g transform={`translate(200 105) scale(${subjectScale}) translate(-200 -105)`}>
            <circle cx="200" cy="70" r="17" fill="#f8fafc" />
            <path d="M169 151c2-43 12-66 31-66s29 23 31 66h-62Z" fill="#c7d2fe" />
            <path d="M181 105h38" stroke="#818cf8" strokeWidth="4" opacity=".7" />
          </g>
        )}
        {exposureBrightness < 1 && <rect width="400" height="168" fill="#020617" opacity={1 - exposureBrightness} />}
        {exposureBrightness > 1 && <rect width="400" height="168" fill="#fff7ed" opacity={(exposureBrightness - 1) * 0.45} />}
        {fisheye && <path d="M2 35Q200 6 398 35M2 142Q200 162 398 142" stroke="#fff" opacity=".22" />}
        <path d="M14 28V14h14M372 14h14v14M386 140v14h-14M28 154H14v-14" stroke="#fff" opacity=".45" />
      </g>
    </svg>
  );
}

function CameraSettingsSelector({
  value = {},
  onChange,
}: {
  value?: CameraGenerationSettings;
  onChange: (value: CameraGenerationSettings | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeCount = Object.values(value).filter(Boolean).length;

  const updateSetting = <K extends keyof CameraGenerationSettings>(
    key: K,
    settingValue: CameraGenerationSettings[K],
  ) => {
    const next = { ...value, [key]: settingValue || undefined };
    onChange(Object.values(next).some(Boolean) ? next : undefined);
  };

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as globalThis.Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside, true);
    return () => document.removeEventListener('pointerdown', closeOnOutside, true);
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        className={`prompt-btn${activeCount > 0 ? ' text-indigo-400 bg-indigo-500/10' : ''}`}
        aria-label={activeCount > 0 ? `摄影参数：已设置 ${activeCount} 项` : '选择摄影参数'}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tooltip={activeCount > 0 ? `摄影参数 · ${activeCount} 项` : '摄影参数'}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M4 8.5h3l1.4-2h7.2l1.4 2h3v9H4z" />
          <circle cx="12" cy="13" r="3.5" />
          <path d="M12 9.5 9.5 13l2.5 3.5 2.5-3.5z" opacity=".6" />
        </svg>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="摄影参数"
          className="absolute bottom-10 left-1/2 z-50 w-[430px] -translate-x-1/2 rounded-xl border border-canvas-border bg-canvas-surface p-3 shadow-2xl"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="mb-2 flex items-center justify-between px-0.5">
            <span className="text-xs font-semibold text-canvas-text">摄影参数</span>
            <button type="button" className="text-[10px] text-canvas-text-muted hover:text-canvas-text" onClick={() => onChange(undefined)}>全部自动</button>
          </div>
          <div className="h-[168px] overflow-hidden rounded-lg border border-canvas-border bg-canvas-bg text-canvas-text">
            <CameraSettingsPreview settings={value} />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="min-w-0 text-[10px] text-canvas-text-muted">
              <span className="mb-1 block">焦距</span>
              <select className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400" value={value.lens ?? ''} onChange={(event) => updateSetting('lens', event.target.value as CameraLens || undefined)}>
                <option value="">自动</option>
                {CAMERA_LENS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="min-w-0 text-[10px] text-canvas-text-muted">
              <span className="mb-1 block">快门效果</span>
              <select className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400" value={value.shutterEffect ?? ''} onChange={(event) => updateSetting('shutterEffect', event.target.value as CameraShutterEffect || undefined)}>
                <option value="">自动</option>
                {CAMERA_SHUTTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="min-w-0 text-[10px] text-canvas-text-muted">
              <span className="mb-1 block">光圈</span>
              <select className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400" value={value.aperture ?? ''} onChange={(event) => updateSetting('aperture', event.target.value as CameraAperture || undefined)}>
                <option value="">自动</option>
                {CAMERA_APERTURE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <label className="min-w-0 text-[10px] text-canvas-text-muted">
              <span className="mb-1 block">曝光时间</span>
              <select className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400" value={value.exposureTime ?? ''} onChange={(event) => updateSetting('exposureTime', event.target.value as CameraExposureTime || undefined)}>
                <option value="">自动</option>
                {CAMERA_EXPOSURE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
          </div>
          <p className="mt-2 px-0.5 text-[9px] text-canvas-text-muted">自动项不会写入提示词；预览仅用于表达景深、明暗、透视与动态趋势。</p>
        </div>
      )}
    </div>
  );
}

function AnimationPoseIcon({ action }: { action: AnimationAction }) {
  const commonProps = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (action) {
    case 'walk':
      return <svg {...commonProps}><circle cx="13" cy="4" r="2" /><path d="m12.5 7-1 7m.5-5-4.5 3.5m4-3 4.5 2.5m-4.5 2L7 20m4.5-6 5 5" /></svg>;
    case 'run':
      return <svg {...commonProps}><circle cx="14.5" cy="4" r="2" /><path d="m13.5 7-3 6m2-4-4.5-2m4 3 5 2m-6.5 1-5 3m5-3 5.5 6" /></svg>;
    case 'jump':
      return <svg {...commonProps}><circle cx="12" cy="4" r="2" /><path d="M12 7v7m0-5L7 5m5 4 5-4m-5 9-4.5 4m4.5-4 4.5 4" /></svg>;
    case 'attack':
      return <svg {...commonProps}><circle cx="9" cy="4.5" r="2" /><path d="m9.5 7 2 7m-1.5-5 7.5 1m-7-1.5L6 12m5.5 2-4.5 6m4.5-6 5 4" /><path d="m17.5 7.5 2.5 2.5-2.5 2.5" /></svg>;
    case 'hit':
      return <svg {...commonProps}><circle cx="14.5" cy="4.5" r="2" /><path d="m13 7-2 7m1-5-5-1m5 2 5 3m-6 1-4 5m4-5 5 5" /><path d="m19 5 2-2m-1 5 3-1" /></svg>;
    default:
      return <svg {...commonProps}><circle cx="12" cy="4" r="2" /><path d="M12 7v7m0-5-4.5 2m4.5-2 4.5 2M12 14l-3.5 6m3.5-6 3.5 6" /></svg>;
  }
}

interface PromptPanelProps {
  nodeType: NodeType;
  nodeId?: string;
  prompt?: string;
  placeholder?: string;
  selectedModel?: string;
  selectedProvider?: string;
  selectedWorkflowId?: string;
  animationAction?: AnimationAction;
  onAnimationActionChange?: (action: AnimationAction) => void;
  animationFrames?: number;
  onAnimationFramesChange?: (value: number) => void;
  canGenerate?: boolean;
  isGenerating?: boolean;
  onCancelGeneration?: () => void;
  onChange: (value: string) => void;
  onContinuousEditEnd?: () => void;
  onSubmit: (overridePrompt?: string, postProcess?: ImagePostProcess) => void;
  onModelSelect: (model: ModelOption) => void;
  onWorkflowSelect?: (workflowId: string | undefined) => void;
  onDebug?: () => void;
  onPassThrough?: () => void;
  imageSize?: string;
  aspectRatio?: string;
  onChangeImageSize?: (size: string) => void;
  onChangeAspectRatio?: (ratio: string) => void;
  batchCount?: number;
  onChangeBatchCount?: (count: number) => void;
  cameraSettings?: CameraGenerationSettings;
  onChangeCameraSettings?: (settings: CameraGenerationSettings | undefined) => void;
  videoResolution?: number;
  videoFps?: number;
  videoFrames?: number;
  onChangeVideoResolution?: (value: number) => void;
  onChangeVideoFps?: (value: number) => void;
  // ── Seedance 参数 ──
  seedanceResolution?: string;
  seedanceRatio?: string;
  seedanceDuration?: number;
  generateAudio?: boolean;
  /** 视频节点：在此节点生成并替换旧视频；false 时生成到右侧新建节点。默认 true。 */
  generateInPlace?: boolean;
  onChangeGenerateInPlace?: (value: boolean) => void;
  /** 不在此节点生成时的数量（1-4），默认 1。 */
  generateCount?: number;
  onChangeGenerateCount?: (value: number) => void;
  videoReferences?: VideoReferenceItem[];
  onChangeVideoReferences?: (value: VideoReferenceItem[]) => void;
  onChangeSeedanceResolution?: (value: string) => void;
  onChangeSeedanceRatio?: (value: string) => void;
  onChangeSeedanceDuration?: (value: number) => void;
  onChangeGenerateAudio?: (value: boolean) => void;
  audioPurpose?: AudioGenerationPurpose;
  audioVoice?: AudioTtsVoice;
  audioFormat?: AudioOutputFormat;
  audioSpeed?: number;
  musicTitle?: string;
  musicLyrics?: string;
  musicBpm?: number;
  musicDuration?: number;
  autoGenerateLyrics?: boolean;
  onChangeAudioVoice?: (value: AudioTtsVoice) => void;
  onChangeAudioFormat?: (value: AudioOutputFormat) => void;
  onChangeAudioSpeed?: (value: number) => void;
  onChangeMusicTitle?: (value: string) => void;
  onChangeMusicLyrics?: (value: string) => void;
  onChangeMusicBpm?: (value: number | undefined) => void;
  onChangeMusicDuration?: (value: number) => void;
  onChangeAutoGenerateLyrics?: (value: boolean) => void;
  workflows?: WorkflowDefinition[];
  editorRef?: React.Ref<MentionEditorHandle>;
  selectedStyle?: string;
  onStyleChange?: (styleId: string) => void;
}

export default function PromptPanel({
  nodeType,
  nodeId,
  prompt = '',
  placeholder = '输入提示词开始创作   (Enter 生成，Shift+Enter 换行)',
  selectedModel,
  selectedProvider,
  selectedWorkflowId,
  animationAction = 'idle',
  onAnimationActionChange,
  animationFrames = 8,
  onAnimationFramesChange,
  canGenerate = true,
  isGenerating = false,
  onCancelGeneration,
  onChange,
  onContinuousEditEnd,
  onSubmit,
  onModelSelect,
  onWorkflowSelect,
  onDebug,
  onPassThrough,
  imageSize,
  aspectRatio,
  onChangeImageSize,
  onChangeAspectRatio,
  batchCount = 1,
  onChangeBatchCount,
  cameraSettings,
  onChangeCameraSettings,
  videoResolution,
  videoFps,
  videoFrames,
  onChangeVideoResolution,
  onChangeVideoFps,
  seedanceResolution,
  seedanceRatio,
  seedanceDuration,
  generateAudio,
  generateInPlace,
  onChangeGenerateInPlace,
  generateCount,
  onChangeGenerateCount,
  videoReferences,
  onChangeVideoReferences,
  onChangeSeedanceResolution,
  onChangeSeedanceRatio,
  onChangeSeedanceDuration,
  onChangeGenerateAudio,
  audioPurpose,
  audioVoice,
  audioFormat,
  audioSpeed,
  musicTitle,
  musicLyrics,
  musicBpm,
  musicDuration,
  autoGenerateLyrics,
  onChangeAudioVoice,
  onChangeAudioFormat,
  onChangeAudioSpeed,
  onChangeMusicTitle,
  onChangeMusicLyrics,
  onChangeMusicBpm,
  onChangeMusicDuration,
  onChangeAutoGenerateLyrics,
  workflows = [],
  editorRef,
  selectedStyle,
  onStyleChange,
}: PromptPanelProps) {
  const [focused, setFocused] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [skillManagerOpen, setSkillManagerOpen] = useState(false);
  const [slashAnchor, setSlashAnchor] = useState<HTMLElement | null>(null);
  const slashBtnRef = useRef<HTMLButtonElement>(null);
  const promptInputRef = useRef<HTMLDivElement>(null);
  const batchTriggerRef = useRef<HTMLDivElement>(null);
  const batchLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressSubmitClickRef = useRef(false);
  const [batchMenuOpen, setBatchMenuOpen] = useState(false);

  const userPresets = useAppStore((s) => s.userPresets);
  const userSkills = useAppStore((s) => s.userSkills);
  const uploadSkill = useAppStore((s) => s.uploadSkill);
  const setPresetManagerOpen = useAppStore((s) => s.setPresetManagerOpen);
  const setPresetRunRequest = useAppStore((s) => s.setPresetRunRequest);
  const showToast = useAppStore((s) => s.showToast);
  const pendingPresetAction = useAppStore((s) => s.pendingPresetAction);
  const setPendingPresetAction = useAppStore((s) => s.setPendingPresetAction);

  const handleSubmit = useCallback((overridePrompt?: string, postProcess?: ImagePostProcess) => {
    const sourcePrompt = overridePrompt ?? prompt;
    onSubmit(expandSkillReferences(sourcePrompt, userSkills), postProcess);
  }, [onSubmit, prompt, userSkills]);

  const handleSingleSubmit = useCallback((overridePrompt?: string, postProcess?: ImagePostProcess) => {
    onChangeBatchCount?.(1);
    setBatchMenuOpen(false);
    handleSubmit(overridePrompt, postProcess);
  }, [handleSubmit, onChangeBatchCount]);

  const clearBatchLongPress = useCallback(() => {
    if (batchLongPressTimerRef.current) {
      clearTimeout(batchLongPressTimerRef.current);
      batchLongPressTimerRef.current = null;
    }
  }, []);

  const batchSupported = nodeType === 'ai-image'
    && Boolean(onChangeBatchCount)
    && selectedProvider !== 'dreamina'
    && !selectedWorkflowId;

  const handleBatchPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (!batchSupported || event.button !== 0 || !canGenerate || !prompt.trim()) return;
    suppressSubmitClickRef.current = false;
    clearBatchLongPress();
    batchLongPressTimerRef.current = setTimeout(() => {
      suppressSubmitClickRef.current = true;
      setBatchMenuOpen(true);
      batchLongPressTimerRef.current = null;
    }, BATCH_LONG_PRESS_MS);
  }, [batchSupported, canGenerate, clearBatchLongPress, prompt]);

  const handleSubmitClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    clearBatchLongPress();
    if (suppressSubmitClickRef.current) {
      suppressSubmitClickRef.current = false;
      return;
    }
    if (canGenerate && prompt.trim()) handleSingleSubmit();
  }, [canGenerate, clearBatchLongPress, handleSingleSubmit, prompt]);

  const handleBatchSelect = useCallback((count: number) => (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onChangeBatchCount?.(count);
    setBatchMenuOpen(false);
    handleSubmit();
  }, [handleSubmit, onChangeBatchCount]);

  useEffect(() => clearBatchLongPress, [clearBatchLongPress]);

  useEffect(() => {
    if (!batchMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!batchTriggerRef.current?.contains(event.target as globalThis.Node)) {
        setBatchMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [batchMenuOpen]);

  const handleSlashSelect = useCallback((filledPrompt: string, shouldTrigger: boolean, preset?: PresetOverride) => {
    setSlashOpen(false);
    // 如果预设绑定了模型/尺寸，写入节点数据（覆盖节点当前设置）
    if (preset) {
      if (preset.model && preset.provider) {
        onModelSelect({ value: preset.model, provider: preset.provider, label: preset.model, nodeTypes: [] });
      }
      if (preset.imageSize && onChangeImageSize) {
        onChangeImageSize(preset.imageSize);
      }
      if (preset.aspectRatio && onChangeAspectRatio) {
        onChangeAspectRatio(preset.aspectRatio);
      }
    }
    if (shouldTrigger) {
      // Direct trigger: combine preset template + input box content, call model directly
      // Don't update the input box — the preset prompt is only used for this generation
      handleSingleSubmit(filledPrompt, preset?.postProcess);
    } else {
      // Insert mode: update input box with filled template, user can edit before generating
      onChange(filledPrompt);
      onContinuousEditEnd?.();
    }
  }, [handleSingleSubmit, onChange, onContinuousEditEnd, onModelSelect, onChangeImageSize, onChangeAspectRatio]);

  // ── 从 Toolbar 点击快捷指令后的自动执行 ──
  useEffect(() => {
    if (!pendingPresetAction || pendingPresetAction.nodeId !== nodeId) return;
    const { filledPrompt, shouldTrigger, override, postProcess } = pendingPresetAction;
    // 清除 pending，防止重复执行
    setPendingPresetAction(null);
    const raf = requestAnimationFrame(() => {
      handleSlashSelect(filledPrompt, shouldTrigger, override ? {
        model: override.model,
        provider: override.provider,
        imageSize: override.imageSize,
        aspectRatio: override.aspectRatio,
        postProcess: postProcess as ImagePostProcess | undefined,
      } : { postProcess: postProcess as ImagePostProcess | undefined });
    });
    return () => cancelAnimationFrame(raf);
  }, [pendingPresetAction, nodeId, handleSlashSelect, setPendingPresetAction]);

  const handleEditorSlash = useCallback(() => {
    setSlashAnchor(promptInputRef.current);
    setSlashOpen(true);
  }, []);

  const handleButtonSlash = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setSlashAnchor(slashBtnRef.current);
    setSlashOpen((open) => !open);
  }, []);

  const handleManagePresets = useCallback(() => {
    setPresetManagerOpen(true);
  }, [setPresetManagerOpen]);

  const handleRunAdvancedPreset = useCallback((preset: UserPreset) => {
    if (!nodeId) {
      showToast('高级快捷指令需要从画布节点中运行', 'error');
      return;
    }
    setPresetRunRequest({ presetId: preset.id, sourceNodeId: nodeId });
  }, [nodeId, setPresetRunRequest, showToast]);

  const handleManageSkills = useCallback(() => {
    setSkillManagerOpen(true);
  }, []);

  const handleSkillSelect = useCallback((skill: UserSkill) => {
    setSlashOpen(false);
    const token = `@skill{${skill.id}|${encodeURIComponent(skill.name)}}`;
    const spacer = prompt && !/\s$/.test(prompt) ? ' ' : '';
    onChange(`${prompt}${spacer}${token}`);
    onContinuousEditEnd?.();
  }, [onChange, onContinuousEditEnd, prompt]);

  const handleUploadSkill = useCallback(async (source: 'file' | 'folder') => {
    setSlashOpen(false);
    try {
      await uploadSkill(source);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '上传 Skill 失败';
      showToast(msg, 'error');
    }
  }, [showToast, uploadSkill]);

  return (
    <>
    <div className={`prompt-panel ${focused ? 'focused' : ''}`}>
      <div className="prompt-input-wrap" ref={promptInputRef}>
        <MentionEditor
          ref={editorRef}
          value={prompt}
          onChange={onChange}
          onSubmit={handleSingleSubmit}
          placeholder={placeholder}
          nodeId={nodeId}
          selectedWorkflowId={selectedWorkflowId}
          canSubmit={canGenerate}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            queueMicrotask(() => onContinuousEditEnd?.());
          }}
          onSlashTrigger={handleEditorSlash}
        />
      </div>
      <div className="prompt-footer">
        <ModelSelector
          nodeType={nodeType}
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
          selectedWorkflowId={selectedWorkflowId}
          onSelect={onModelSelect}
          onWorkflowSelect={onWorkflowSelect}
          workflows={workflows}
        />

        {nodeType === 'ai-animation' && onAnimationActionChange && (
          <>
            <div className="animation-action-picker" role="group" aria-label="动画动作">
              {ANIMATION_ACTIONS.map((action) => (
                <button
                  key={action}
                  type="button"
                  className={`animation-pose-btn${animationAction === action ? ' active' : ''}`}
                  data-tooltip={ANIMATION_ACTION_LABELS[action]}
                  aria-label={ANIMATION_ACTION_LABELS[action]}
                  aria-pressed={animationAction === action}
                  onClick={(event) => {
                    event.stopPropagation();
                    onAnimationActionChange(action);
                  }}
                >
                  <AnimationPoseIcon action={action} />
                </button>
              ))}
            </div>
            <select
              className="animation-frames-select"
              value={animationFrames}
              aria-label="生成帧数"
              onChange={(event) => {
                event.stopPropagation();
                onAnimationFramesChange?.(Number(event.target.value));
              }}
            >
              {[6, 8, 10, 12, 16, 20].map((count) => (
                <option key={count} value={count}>{count} 帧</option>
              ))}
            </select>
          </>
        )}

        {(nodeType === 'ai-image' || nodeType === 'ai-panorama' || nodeType === 'ai-video') && (
          <StyleSelector
            nodeType={nodeType}
            selectedStyle={selectedStyle}
            onChange={onStyleChange}
          />
        )}

        {(nodeType === 'ai-image' || nodeType === 'ai-video') && onChangeCameraSettings && (
          <CameraSettingsSelector value={cameraSettings} onChange={onChangeCameraSettings} />
        )}

        {nodeType === 'ai-image' && (
          <QualityRatioSelector
            imageSize={imageSize}
            aspectRatio={aspectRatio}
            onChangeImageSize={onChangeImageSize || (() => {})}
            onChangeAspectRatio={onChangeAspectRatio || (() => {})}
          />
        )}

        {nodeType === 'ai-panorama' && (
          <QualityRatioSelector
            imageSize={imageSize}
            aspectRatio={aspectRatio}
            onChangeImageSize={onChangeImageSize || (() => {})}
            onChangeAspectRatio={onChangeAspectRatio || (() => {})}
            showAdaptive={false}
            ratios={[
              { value: '2:1', className: 'img-rp-pano' },
              { value: '21:9', className: 'img-rp-ultra' },
            ]}
          />
        )}

        {nodeType === 'ai-video' && (
          <VideoParamSelector
            provider={selectedProvider}
            selectedModel={selectedModel}
            nodeId={nodeId}
            videoReferences={videoReferences}
            onChangeVideoReferences={onChangeVideoReferences}
            videoResolution={videoResolution}
            videoFps={videoFps}
            videoFrames={videoFrames}
            onChangeResolution={onChangeVideoResolution || (() => {})}
            onChangeFps={onChangeVideoFps || (() => {})}
            seedanceResolution={seedanceResolution}
            seedanceRatio={seedanceRatio}
            seedanceDuration={seedanceDuration}
            generateAudio={generateAudio}
            generateInPlace={generateInPlace}
            generateCount={generateCount}
            onChangeGenerateInPlace={onChangeGenerateInPlace}
            onChangeGenerateCount={onChangeGenerateCount}
            onChangeSeedanceResolution={onChangeSeedanceResolution}
            onChangeSeedanceRatio={onChangeSeedanceRatio}
            onChangeSeedanceDuration={onChangeSeedanceDuration}
            onChangeGenerateAudio={onChangeGenerateAudio}
            onContinuousEditEnd={onContinuousEditEnd}
          />
        )}

        {nodeType === 'ai-audio' && (
          <AudioParamSelector
            purpose={audioPurpose}
            voice={audioVoice}
            format={audioFormat}
            speed={audioSpeed}
            musicTitle={musicTitle}
            musicLyrics={musicLyrics}
            musicBpm={musicBpm}
            musicDuration={musicDuration}
            autoGenerateLyrics={autoGenerateLyrics}
            onChangeVoice={onChangeAudioVoice}
            onChangeFormat={onChangeAudioFormat}
            onChangeSpeed={onChangeAudioSpeed}
            onChangeMusicTitle={onChangeMusicTitle}
            onChangeMusicLyrics={onChangeMusicLyrics}
            onChangeMusicBpm={onChangeMusicBpm}
            onChangeMusicDuration={onChangeMusicDuration}
            onChangeAutoGenerateLyrics={onChangeAutoGenerateLyrics}
            onContinuousEditEnd={onContinuousEditEnd}
          />
        )}

        <div className="prompt-actions">
          {/* Slash command button — only for ai-image and ai-text node types */}
          {(nodeType === 'ai-image' || nodeType === 'ai-text') && (
            <button
              ref={slashBtnRef}
              type="button"
              className={`prompt-btn prompt-slash-btn${slashOpen ? ' slash-active' : ''}`}
              data-tooltip="预设提示词"
              onClick={handleButtonSlash}
            >
              /
            </button>
          )}
          {onDebug && (
            <button
              type="button"
              className="prompt-btn prompt-debug-btn"
              data-tooltip="调试 API 参数"
              onClick={(e) => { e.stopPropagation(); onDebug(); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
              </svg>
            </button>
          )}
          {onPassThrough && (
            <button
              type="button"
              className={`prompt-btn prompt-pass-through-btn ${!prompt.trim() ? 'disabled' : ''}`}
              disabled={!canGenerate || !prompt.trim()}
              data-tooltip="直接输出（跳过模型调用）"
              onClick={(e) => {
                e.stopPropagation();
                if (prompt.trim()) onPassThrough();
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          )}
          {isGenerating && onCancelGeneration ? (
            <div className="prompt-submit-wrap">
              <button
                type="button"
                className="prompt-btn prompt-stop-btn"
                data-tooltip="终止 ComfyUI 任务"
                aria-label="终止 ComfyUI 任务"
                onClick={(event) => {
                  event.stopPropagation();
                  onCancelGeneration();
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="5" y="5" width="14" height="14" rx="2" />
                </svg>
              </button>
            </div>
          ) : (
            <div
              ref={batchTriggerRef}
              className={`prompt-submit-wrap${batchMenuOpen ? ' batch-open' : ''}`}
            >
              <button
                type="button"
                className={`prompt-btn prompt-submit-btn ${!canGenerate || !prompt.trim() ? 'disabled' : ''}`}
                disabled={!canGenerate || !prompt.trim()}
                aria-haspopup={batchSupported ? 'menu' : undefined}
                aria-expanded={batchSupported ? batchMenuOpen : undefined}
                data-tooltip={batchSupported ? '点击生成 1 张，长按选择数量' : '调用模型生成'}
                onPointerDown={handleBatchPointerDown}
                onPointerUp={clearBatchLongPress}
                onPointerCancel={clearBatchLongPress}
                onPointerLeave={clearBatchLongPress}
                onContextMenu={(event) => { if (batchSupported) event.preventDefault(); }}
                onClick={handleSubmitClick}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
              {batchSupported && (
                <div className="image-batch-clip">
                  <div
                    className="image-batch-menu"
                    role="menu"
                    aria-label="选择批量生成数量"
                    aria-hidden={!batchMenuOpen}
                  >
                    {IMAGE_BATCH_COUNTS.map((count) => (
                      <button
                        key={count}
                        type="button"
                        role="menuitem"
                        tabIndex={batchMenuOpen ? 0 : -1}
                        className={`image-batch-menu-item${batchCount === count ? ' active' : ''}`}
                        aria-label={`生成 ${count} 张图片`}
                        title={count >= 4 ? `生成 ${count} 张，费用可能按张计算` : `生成 ${count} 张`}
                        onClick={handleBatchSelect(count)}
                      >
                        {count}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
    {slashOpen && (
      <SlashCommandMenu
        nodeType={nodeType}
        currentPrompt={prompt}
        anchorEl={slashAnchor}
        userPresets={userPresets}
        userSkills={userSkills}
        onSelect={handleSlashSelect}
        onRunAdvancedPreset={handleRunAdvancedPreset}
        onSelectSkill={handleSkillSelect}
        onUploadSkill={handleUploadSkill}
        onManageSkills={handleManageSkills}
        onClose={() => setSlashOpen(false)}
        onManagePresets={handleManagePresets}
      />
    )}
    <PresetManager />
    <SkillManager open={skillManagerOpen} onClose={() => setSkillManagerOpen(false)} />
    </>
  );
}
