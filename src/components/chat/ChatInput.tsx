/**
 * ChatInput — 输入区组件
 *
 * 常驻对话模型选择器；媒体模型通过轻量 @model mention 按轮覆盖。
 */
import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import AnimatedButton from '../shared/AnimatedButton';
import ChatModelSelector from './ChatModelSelector';
import type { GeneralModelConfig } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import {
  getMediaModelOptions,
  type MediaModelOption,
} from '../nodes/shared/defaultModels';

function fuzzyMatchModel(model: MediaModelOption, rawQuery: string): boolean {
  const query = rawQuery.trim().toLocaleLowerCase().replace(/\s+/g, '');
  if (!query) return true;
  const text = [model.label, model.value, model.provider, model.groupName, model.description]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase()
    .replace(/\s+/g, '');
  if (text.includes(query)) return true;
  let cursor = 0;
  for (const char of query) {
    cursor = text.indexOf(char, cursor);
    if (cursor < 0) return false;
    cursor += 1;
  }
  return true;
}

function fuzzyMatchText(rawQuery: string, ...values: Array<string | number | undefined>): boolean {
  const query = rawQuery.trim().toLocaleLowerCase().replace(/\s+/g, '');
  if (!query) return true;
  const text = values.filter((value) => value != null).join(' ').toLocaleLowerCase().replace(/\s+/g, '');
  if (text.includes(query)) return true;
  let cursor = 0;
  for (const char of query) {
    cursor = text.indexOf(char, cursor);
    if (cursor < 0) return false;
    cursor += 1;
  }
  return true;
}

interface ChatInputProps {
  /** 当前选中的文本模型 ID */
  assistantModelId?: string;
  onAssistantModelChange: (modelId?: string) => void;
  mediaModels: GeneralModelConfig[];
  inputValue: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
}

export default function ChatInput({
  assistantModelId,
  onAssistantModelChange,
  mediaModels,
  inputValue,
  onInputChange,
  onSend,
  disabled = false,
}: ChatInputProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [mentionCursor, setMentionCursor] = useState(0);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState('');
  const [skillCursor, setSkillCursor] = useState(0);
  const [skillUploading, setSkillUploading] = useState(false);
  const providers = useAppStore((state) => state.config.providers);
  const dreaminaLoggedIn = useAppStore((state) => !!state.config.dreaminaAuth?.loggedIn);
  const canvasNodes = useAppStore((state) => state.nodes);
  const userSkills = useAppStore((state) => state.userSkills);
  const uploadSkill = useAppStore((state) => state.uploadSkill);
  const showToast = useAppStore((state) => state.showToast);
  const compatibleMediaModels = useMemo(
    () => getMediaModelOptions(mediaModels),
    [mediaModels],
  );
  const groupedMediaModels = useMemo(() => {
    const groups = new Map<string, { id: string; name: string; models: MediaModelOption[] }>();
    for (const model of compatibleMediaModels) {
      if (!fuzzyMatchModel(model, modelQuery)) continue;
      const group = groups.get(model.groupId) ?? {
        id: model.groupId,
        name: model.groupName,
        models: [],
      };
      group.models.push(model);
      groups.set(model.groupId, group);
    }
    return [...groups.values()];
  }, [compatibleMediaModels, modelQuery]);
  const filteredCanvasNodes = useMemo(() => canvasNodes
    .filter((node) => node.type !== 'group')
    .filter((node) => fuzzyMatchText(
      modelQuery,
      node.data.label,
      node.data.displayId,
      node.data.displayId != null ? `#${String(node.data.displayId)}` : undefined,
      node.data.type,
      node.id,
    )), [canvasNodes, modelQuery]);
  const filteredSkills = useMemo(() => userSkills.filter((skill) => fuzzyMatchText(
    skillQuery,
    skill.name,
    skill.description,
    skill.fileName,
  )), [skillQuery, userSkills]);

  const isModelAvailable = useCallback((model: MediaModelOption) => {
    if (model.provider === 'general') return true;
    if (model.provider === 'dreamina') return dreaminaLoggedIn;
    const providerKey = model.provider === 'runninghubwf' ? 'runninghub' : model.provider;
    return !!providers[providerKey]?.apiKey;
  }, [dreaminaLoggedIn, providers]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    },
    [onSend],
  );

  const insertModelMention = useCallback((model: MediaModelOption) => {
    const cursor = Math.min(mentionCursor, inputValue.length);
    const before = inputValue.slice(0, cursor);
    const after = inputValue.slice(cursor);
    const mentionStart = before.search(/@[^\s@]*$/);
    const prefix = mentionStart >= 0 ? before.slice(0, mentionStart) : `${before}${before && !before.endsWith(' ') ? ' ' : ''}`;
    const nextValue = `${prefix}@model{${model.value}|${model.label}} ${after}`;
    onInputChange(nextValue);
    setModelMenuOpen(false);
    setModelQuery('');
  }, [inputValue, mentionCursor, onInputChange]);

  const insertNodeMention = useCallback((nodeId: string, label: string) => {
    const cursor = Math.min(mentionCursor, inputValue.length);
    const before = inputValue.slice(0, cursor);
    const after = inputValue.slice(cursor);
    const mentionStart = before.search(/@[^\s@]*$/);
    const prefix = mentionStart >= 0 ? before.slice(0, mentionStart) : `${before}${before && !before.endsWith(' ') ? ' ' : ''}`;
    const safeLabel = label.replace(/}/g, '').trim() || '节点';
    onInputChange(`${prefix}@{${nodeId}:${safeLabel}} ${after}`);
    setModelMenuOpen(false);
    setModelQuery('');
  }, [inputValue, mentionCursor, onInputChange]);

  const insertSkillReference = useCallback((skillId: string, skillName: string) => {
    const cursor = Math.min(skillCursor, inputValue.length);
    const before = inputValue.slice(0, cursor);
    const after = inputValue.slice(cursor);
    const slashStart = before.search(/\/[^\s/]*$/);
    const prefix = slashStart >= 0 ? before.slice(0, slashStart) : `${before}${before && !before.endsWith(' ') ? ' ' : ''}`;
    const token = `@skill{${skillId}|${encodeURIComponent(skillName)}}`;
    onInputChange(`${prefix}${token} ${after}`);
    setSkillMenuOpen(false);
    setSkillQuery('');
  }, [inputValue, onInputChange, skillCursor]);

  const handleUploadSkill = useCallback(async () => {
    if (skillUploading) return;
    setSkillUploading(true);
    try {
      await uploadSkill('file');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '上传 Skill 失败', 'error');
    } finally {
      setSkillUploading(false);
    }
  }, [showToast, skillUploading, uploadSkill]);

  // 自动聚焦
  useEffect(() => {
    if (!disabled) {
      inputRef.current?.focus();
    }
  }, [disabled]);

  return (
    <div className="chat-panel-input-area flex-shrink-0 px-3 pt-2 pb-1">
      <div
        className="chat-panel-input-box relative flex flex-col bg-canvas-card border border-canvas-border rounded-[14px]
                    focus-within:border-canvas-text-secondary transition-colors px-4 pt-4 pb-3 shadow-lg"
      >
        <textarea
          ref={inputRef}
          value={inputValue}
          onChange={(e) => {
            onInputChange(e.target.value);
            const cursor = e.target.selectionStart;
            const beforeCursor = e.target.value.slice(0, cursor);
            const mention = /@([^\s@]*)$/.exec(beforeCursor);
            const slash = /(?:^|\s)\/([^\s/]*)$/.exec(beforeCursor);
            setMentionCursor(cursor);
            setModelMenuOpen(!!mention);
            setModelQuery(mention?.[1] ?? '');
            setSkillCursor(cursor);
            setSkillMenuOpen(!mention && !!slash);
            setSkillQuery(slash?.[1] ?? '');
          }}
          onKeyDown={handleKeyDown}
          placeholder="输入消息，描述你想对画布进行的修改"
          rows={1}
          disabled={disabled}
          className="chat-panel-textarea w-full resize-none bg-transparent text-[15px] leading-6 text-canvas-text
                     placeholder:text-canvas-text-muted outline-none
                     min-h-[64px] max-h-[160px]"
        />

        <div className="chat-panel-input-toolbar mt-2 flex items-end justify-between gap-3">
          {modelMenuOpen && (
            <div className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-20 max-h-72 overflow-y-auto rounded-xl border border-canvas-border bg-canvas-surface p-1 shadow-xl">
              {filteredCanvasNodes.length > 0 && (
                <div className="py-1">
                  <div className="sticky top-0 z-10 flex items-center justify-between bg-canvas-surface px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-canvas-text-muted">
                    <span>画布节点</span>
                    <span>{filteredCanvasNodes.length}</span>
                  </div>
                  {filteredCanvasNodes.map((node) => (
                    <button
                      key={node.id}
                      type="button"
                      onClick={() => insertNodeMention(node.id, String(node.data.label || '节点'))}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-canvas-text hover:bg-canvas-hover"
                    >
                      <Icon icon="mdi:vector-square" width="16" />
                      <span className="min-w-0 flex-1 truncate">{String(node.data.label || '节点')}</span>
                      {node.data.displayId != null && (
                        <span className="text-[10px] text-canvas-text-muted">#{String(node.data.displayId)}</span>
                      )}
                      <span className="text-[10px] text-canvas-text-muted">{String(node.data.type)}</span>
                    </button>
                  ))}
                </div>
              )}
              {groupedMediaModels.map((group) => (
                <div key={group.id} className="py-1">
                  <div className="sticky top-0 z-10 flex items-center justify-between bg-canvas-surface px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-canvas-text-muted">
                    <span>{group.name}</span>
                    <span>{group.models.length}</span>
                  </div>
                  {group.models.map((model) => {
                    const available = isModelAvailable(model);
                    return (
                      <button
                        key={`${model.mediaKind}:${model.value}`}
                        type="button"
                        disabled={!available}
                        onClick={() => insertModelMention(model)}
                        title={available ? model.description : '请先配置对应供应商'}
                        className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs ${available ? 'text-canvas-text hover:bg-canvas-hover' : 'cursor-not-allowed text-canvas-text-muted opacity-50'}`}
                      >
                        <Icon icon={model.mediaKind === 'image' ? 'mdi:image-outline' : 'mdi:video-outline'} width="16" />
                        <span className="min-w-0 flex-1 truncate">{model.label}</span>
                        <span className="text-[10px] text-canvas-text-muted">{model.mediaKind === 'image' ? '图片' : '视频'}</span>
                        {!available && <Icon icon="mdi:lock-outline" width="13" />}
                      </button>
                    );
                  })}
                </div>
              ))}
              {filteredCanvasNodes.length === 0 && groupedMediaModels.length === 0 && (
                <p className="px-3 py-3 text-center text-xs text-canvas-text-muted">
                  {modelQuery ? `没有匹配“${modelQuery}”的节点或模型` : '暂无可引用的节点或模型'}
                </p>
              )}
            </div>
          )}
          {skillMenuOpen && (
            <div className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-20 max-h-72 overflow-y-auto rounded-xl border border-canvas-border bg-canvas-surface p-1 shadow-xl">
              <div className="sticky top-0 z-10 flex items-center justify-between bg-canvas-surface px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-canvas-text-muted">
                <span>Skill</span>
                <span className="flex items-center gap-2">
                  <span>{filteredSkills.length}</span>
                  <button
                    type="button"
                    disabled={skillUploading}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleUploadSkill();
                    }}
                    aria-label="上传 Skill"
                    title="上传 Skill 文件"
                    className="flex h-6 w-6 items-center justify-center rounded-md text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text disabled:cursor-wait disabled:opacity-50"
                  >
                    <Icon icon={skillUploading ? 'mdi:loading' : 'mdi:plus'} width="15" className={skillUploading ? 'animate-spin' : ''} />
                  </button>
                </span>
              </div>
              {filteredSkills.length > 0 ? filteredSkills.map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => insertSkillReference(skill.id, skill.name)}
                  title={skill.description}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-canvas-text hover:bg-canvas-hover"
                >
                  <Icon icon="mdi:puzzle-outline" width="16" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{skill.name}</span>
                    <span className="block truncate text-[10px] text-canvas-text-muted">{skill.description}</span>
                  </span>
                </button>
              )) : (
                <p className="px-3 py-3 text-center text-xs text-canvas-text-muted">
                  {skillQuery ? `没有匹配“${skillQuery}”的 Skill` : '暂无已上传 Skill'}
                </p>
              )}
            </div>
          )}

          <div className="flex items-center gap-2 min-w-0 flex-1">
            <ChatModelSelector
              category="text"
              selectedId={assistantModelId}
              onSelect={onAssistantModelChange}
            />
            <button
              type="button"
              onClick={() => {
                setModelQuery('');
                setMentionCursor(inputValue.length);
                setSkillMenuOpen(false);
                setModelMenuOpen((open) => !open);
              }}
              aria-label="引用画布节点或媒体模型"
              className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text"
            >
              <Icon icon="mdi:at" width="16" />
              引用
            </button>
            <button
              type="button"
              onClick={() => {
                setSkillQuery('');
                setSkillCursor(inputValue.length);
                setModelMenuOpen(false);
                setSkillMenuOpen((open) => !open);
              }}
              aria-label="调用 Skill"
              className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text"
            >
              <Icon icon="mdi:slash-forward" width="16" />
              Skill
            </button>
          </div>

          <AnimatedButton
            scale={1.05}
            disabled={!inputValue.trim() || disabled}
            aria-label="发送消息"
            className={`chat-panel-send-btn flex shrink-0 items-center justify-center w-10 h-10 rounded-full transition-colors
                        ${inputValue.trim() && !disabled
                          ? 'bg-canvas-text text-canvas-bg hover:opacity-90'
                          : 'bg-canvas-hover text-canvas-text-muted cursor-not-allowed'
                        }`}
            onClick={onSend}
          >
            <Icon icon="mdi:arrow-up" width="20" height="20" />
          </AnimatedButton>
        </div>
      </div>

      {/* Disclaimer */}
      <p className="chat-panel-disclaimer text-[10px] text-canvas-text-muted mt-1 text-center px-4">
        AI 助手仅理解画布操作指令，不会执行未授权的修改。
      </p>
    </div>
  );
}
