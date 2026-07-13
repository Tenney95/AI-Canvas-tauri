/**
 * PromptPanel 提示词面板 — AI 生成节点的核心输入面板，集成模型选择器、提示词编辑器、质量/比例/视频参数、生成按钮、/ 指令菜单
 */
import { useState, useRef, useCallback } from 'react';
import type { NodeType, ModelOption, WorkflowDefinition, UserSkill, UserPreset } from '../../../types';
import { useAppStore } from '../../../store/useAppStore';
import ModelSelector from './ModelSelector';
import QualityRatioSelector from './QualityRatioSelector';
import VideoParamSelector from './VideoParamSelector';
import StyleSelector from './StyleSelector';
import MentionEditor, { type MentionEditorHandle } from './MentionEditor';
import SlashCommandMenu from './SlashCommandMenu';
import PresetManager from './PresetManager';
import SkillManager from './SkillManager';
import { expandSkillReferences } from '../../../services/skillPromptService';

interface PromptPanelProps {
  nodeType: NodeType;
  nodeId?: string;
  prompt?: string;
  placeholder?: string;
  selectedModel?: string;
  selectedProvider?: string;
  selectedWorkflowId?: string;
  canGenerate?: boolean;
  onChange: (value: string) => void;
  onSubmit: (overridePrompt?: string) => void;
  onModelSelect: (model: ModelOption) => void;
  onWorkflowSelect?: (workflowId: string | undefined) => void;
  onDebug?: () => void;
  onPassThrough?: () => void;
  imageSize?: string;
  aspectRatio?: string;
  onChangeImageSize?: (size: string) => void;
  onChangeAspectRatio?: (ratio: string) => void;
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
  canGenerate = true,
  onChange,
  onSubmit,
  onModelSelect,
  onWorkflowSelect,
  onDebug,
  onPassThrough,
  imageSize,
  aspectRatio,
  onChangeImageSize,
  onChangeAspectRatio,
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

  const userPresets = useAppStore((s) => s.userPresets);
  const userSkills = useAppStore((s) => s.userSkills);
  const uploadSkill = useAppStore((s) => s.uploadSkill);
  const setPresetManagerOpen = useAppStore((s) => s.setPresetManagerOpen);
  const showToast = useAppStore((s) => s.showToast);

  const handleSubmit = useCallback((overridePrompt?: string) => {
    const sourcePrompt = overridePrompt ?? prompt;
    onSubmit(expandSkillReferences(sourcePrompt, userSkills));
  }, [onSubmit, prompt, userSkills]);

  const handleSlashSelect = useCallback((filledPrompt: string, shouldTrigger: boolean, preset?: UserPreset) => {
    setSlashOpen(false);
    // 如果预设绑定了模型/尺寸，写入节点数据（覆盖节点当前设置）
    if (preset) {
      if (preset.model && preset.provider) {
        onModelSelect({ value: preset.model, provider: preset.provider, label: preset.model, nodeTypes: [] });
      }
      if (preset.imageSize && onChangeImageSize) {
        onChangeImageSize(preset.imageSize);
        if (preset.aspectRatio && onChangeAspectRatio) {
          queueMicrotask(() => onChangeAspectRatio(preset.aspectRatio!));
        }
      } else if (preset.aspectRatio && onChangeAspectRatio) {
        onChangeAspectRatio(preset.aspectRatio);
      }
    }
    if (shouldTrigger) {
      // Direct trigger: combine preset template + input box content, call model directly
      // Don't update the input box — the preset prompt is only used for this generation
      handleSubmit(filledPrompt);
    } else {
      // Insert mode: update input box with filled template, user can edit before generating
      onChange(filledPrompt);
    }
  }, [handleSubmit, onChange, onModelSelect, onChangeImageSize, onChangeAspectRatio]);

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

  const handleManageSkills = useCallback(() => {
    setSkillManagerOpen(true);
  }, []);

  const handleSkillSelect = useCallback((skill: UserSkill) => {
    setSlashOpen(false);
    const token = `@skill{${skill.id}|${encodeURIComponent(skill.name)}}`;
    const spacer = prompt && !/\s$/.test(prompt) ? ' ' : '';
    onChange(`${prompt}${spacer}${token}`);
  }, [onChange, prompt]);

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
          onSubmit={handleSubmit}
          placeholder={placeholder}
          nodeId={nodeId}
          selectedWorkflowId={selectedWorkflowId}
          canSubmit={canGenerate}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
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
          <button
            type="button"
            className={`prompt-btn prompt-submit-btn ${!canGenerate || !prompt.trim() ? 'disabled' : ''}`}
            disabled={!canGenerate || !prompt.trim()}
            data-tooltip="调用模型生成"
            onClick={(e) => {
              e.stopPropagation();
              if (canGenerate && prompt.trim()) handleSubmit();
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
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
