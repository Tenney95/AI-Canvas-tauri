/**
 * PromptPanel 提示词面板 — AI 生成节点的核心输入面板，集成模型选择器、提示词编辑器、质量/比例/视频参数、生成按钮、/ 指令菜单
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import type { AnimationAction, ImagePostProcess, NodeType, ModelOption, WorkflowDefinition, UserPreset, UserSkill } from '../../../types';
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
import type { AudioOutputFormat, AudioTtsVoice } from '../../../types/aiTypes';
import type { AudioGenerationPurpose } from '../../../types/media';

const ANIMATION_ACTIONS: AnimationAction[] = ['idle', 'walk', 'run', 'jump', 'attack', 'hit'];
const IMAGE_BATCH_COUNTS = Array.from({ length: MAX_IMAGE_BATCH_COUNT - 1 }, (_, index) => index + 2);
const BATCH_LONG_PRESS_MS = 450;

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
  videoResolution?: number;
  videoFps?: number;
  videoFrames?: number;
  onChangeVideoResolution?: (value: number) => void;
  onChangeVideoFps?: (value: number) => void;
  onChangeVideoFrames?: (value: number) => void;
  // ── Seedance 参数 ──
  seedanceResolution?: string;
  seedanceRatio?: string;
  seedanceDuration?: number;
  generateAudio?: boolean;
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
  videoResolution,
  videoFps,
  videoFrames,
  onChangeVideoResolution,
  onChangeVideoFps,
  onChangeVideoFrames,
  seedanceResolution,
  seedanceRatio,
  seedanceDuration,
  generateAudio,
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
            videoResolution={videoResolution}
            videoFps={videoFps}
            videoFrames={videoFrames}
            onChangeResolution={onChangeVideoResolution || (() => {})}
            onChangeFps={onChangeVideoFps || (() => {})}
            onChangeFrames={onChangeVideoFrames || (() => {})}
            seedanceResolution={seedanceResolution}
            seedanceRatio={seedanceRatio}
            seedanceDuration={seedanceDuration}
            generateAudio={generateAudio}
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
