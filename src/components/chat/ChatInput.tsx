/**
 * ChatInput — 输入区组件
 *
 * 常驻对话模型选择器；媒体模型通过轻量 @model mention 按轮覆盖。
 */
import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Icon } from '@iconify/react';
import { convertFileSrc } from '@tauri-apps/api/core';
import AnimatedButton from '../shared/AnimatedButton';
import ModelSelector from '../nodes/shared/ModelSelector';
import ContextUsageIndicator from './ContextUsageIndicator';
import ChatComposerEditor, { type ChatComposerEditorHandle } from './ChatComposerEditor';
import type { BaseNodeData, GeneralModelConfig, ModelOption } from '../../types';
import type { ContextUsageStat } from '../../services/chat/contextManager';
import { useAppStore } from '../../store/useAppStore';
import { isSkillUserInvocable } from '../../services/skillPromptService';
import {
  type MediaModelOption,
} from '../nodes/shared/defaultModels';
import type { LocalFileGrantSummary } from '../../services/chat/fileGrantService';

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
type ReferenceScope = 'all' | 'nodes' | 'models';
type ReferenceSuggestion =
  | { key: string; kind: 'node'; nodeId: string; label: string; displayId?: number }
  | { key: string; kind: 'model'; model: MediaModelOption };

const REFERENCE_SUGGESTION_LIST_ID = 'chat-reference-suggestions';
const SKILL_SUGGESTION_LIST_ID = 'chat-skill-suggestions';

function parseReferenceQuery(query: string): { scope: ReferenceScope; query: string } {
  const shortcut = query.toLocaleLowerCase();
  if (shortcut === 'n') return { scope: 'nodes', query: '' };
  if (shortcut === 'm') return { scope: 'models', query: '' };
  return { scope: 'all', query };
}

function resolveNodeThumbnail(data: BaseNodeData): string | undefined {
  if (data.imageUrl) {
    if (data.filePath && IS_TAURI) {
      try {
        return convertFileSrc(data.filePath);
      } catch {
        return data.thumbnailUrl || data.imageUrl;
      }
    }
    return data.thumbnailUrl || data.imageUrl;
  }
  return data.thumbnailUrl;
}

function NodeReferenceThumbnail({ data }: { data: BaseNodeData }) {
  const source = resolveNodeThumbnail(data);
  const [failedSource, setFailedSource] = useState<string>();

  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md border border-canvas-border/60 bg-canvas-card text-canvas-text-secondary shadow-sm">
      {source && failedSource !== source ? (
        <img
          src={source}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setFailedSource(source)}
          className="h-full w-full object-cover"
        />
      ) : (
        <Icon icon="mdi:vector-square" width="16" />
      )}
    </span>
  );
}

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
  mediaModelOptions: MediaModelOption[];
  mediaModelAvailability: Record<string, boolean>;
  inputValue: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  hasActiveTask?: boolean;
  onInterject?: () => void;
  localFileGrants?: LocalFileGrantSummary[];
  onAuthorizeLocalFiles?: () => void;
  onRevokeLocalFile?: (grantId: string) => void;
  /** 当前会话上下文占用（估算）；无会话时为 null */
  contextUsage?: ContextUsageStat | null;
  disabled?: boolean;
}

export default function ChatInput({
  assistantModelId,
  onAssistantModelChange,
  mediaModels,
  mediaModelOptions,
  mediaModelAvailability,
  inputValue,
  onInputChange,
  onSend,
  hasActiveTask = false,
  onInterject,
  localFileGrants = [],
  onAuthorizeLocalFiles,
  onRevokeLocalFile,
  contextUsage,
  disabled = false,
}: ChatInputProps) {
  const inputRef = useRef<ChatComposerEditorHandle>(null);
  const reduceMotion = useReducedMotion();
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [referenceScope, setReferenceScope] = useState<ReferenceScope>('all');
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState('');
  const [skillUploading, setSkillUploading] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const canvasNodes = useAppStore((state) => state.nodes);
  const userSkills = useAppStore((state) => state.userSkills);
  const uploadSkill = useAppStore((state) => state.uploadSkill);
  const showToast = useAppStore((state) => state.showToast);
  const compatibleMediaModels = mediaModelOptions;
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
  const filteredSkills = useMemo(() => userSkills
    .filter(isSkillUserInvocable)
    .filter((skill) => fuzzyMatchText(
      skillQuery,
      skill.name,
      skill.description,
      skill.fileName,
    )), [skillQuery, userSkills]);
  const nodeDisplayIds = useMemo(
    () => new Map(canvasNodes.map((node) => [node.id, node.data.displayId])),
    [canvasNodes],
  );
  const visibleCanvasNodes = useMemo(
    () => referenceScope === 'models' ? [] : filteredCanvasNodes,
    [filteredCanvasNodes, referenceScope],
  );
  const visibleMediaGroups = useMemo(
    () => referenceScope === 'nodes' ? [] : groupedMediaModels,
    [groupedMediaModels, referenceScope],
  );

  const modelGroupAvailability = useMemo(() => {
    const availability: Record<string, boolean> = { 'general-models': true };
    for (const model of compatibleMediaModels) {
      availability[model.groupId] = availability[model.groupId]
        || !!mediaModelAvailability[model.value];
    }
    return availability;
  }, [compatibleMediaModels, mediaModelAvailability]);

  const isModelAvailable = useCallback(
    (model: MediaModelOption) => !!mediaModelAvailability[model.value],
    [mediaModelAvailability],
  );

  const handleTextModelSelect = useCallback((model: ModelOption) => {
    const modelId = model.value.startsWith('general/')
      ? model.value.slice('general/'.length)
      : model.value;
    onAssistantModelChange(modelId);
  }, [onAssistantModelChange]);

  const selectedTextModel = useMemo(() => {
    if (!assistantModelId || assistantModelId.startsWith('general/')) return assistantModelId;
    const isGeneralModel = mediaModels.some((model) => (
      model.category === 'text' && model.id === assistantModelId
    ));
    return isGeneralModel ? `general/${assistantModelId}` : assistantModelId;
  }, [assistantModelId, mediaModels]);

  const insertModelMention = useCallback((model: MediaModelOption) => {
    inputRef.current?.insertReference({
      kind: 'model',
      id: model.value,
      label: model.label,
    });
    setModelMenuOpen(false);
    setModelQuery('');
    setReferenceScope('all');
    setActiveSuggestionIndex(0);
  }, []);

  const insertNodeMention = useCallback((nodeId: string, label: string, displayId?: number) => {
    inputRef.current?.insertReference({
      kind: 'node',
      id: nodeId,
      label,
      displayId,
    });
    setModelMenuOpen(false);
    setModelQuery('');
    setReferenceScope('all');
    setActiveSuggestionIndex(0);
  }, []);

  const insertSkillReference = useCallback((skillId: string, skillName: string) => {
    inputRef.current?.insertReference({
      kind: 'skill',
      id: skillId,
      label: skillName,
    });
    setSkillMenuOpen(false);
    setSkillQuery('');
    setActiveSuggestionIndex(0);
  }, []);

  const referenceSuggestions = useMemo<ReferenceSuggestion[]>(() => [
    ...visibleCanvasNodes.map((node) => ({
      key: `node:${node.id}`,
      kind: 'node' as const,
      nodeId: node.id,
      label: String(node.data.label || '节点'),
      displayId: node.data.displayId,
    })),
    ...visibleMediaGroups.flatMap((group) => group.models
      .filter(isModelAvailable)
      .map((model) => ({
        key: `model:${model.mediaKind}:${model.value}`,
        kind: 'model' as const,
        model,
      }))),
  ], [isModelAvailable, visibleCanvasNodes, visibleMediaGroups]);
  const skillSuggestions = useMemo(
    () => filteredSkills.map((skill) => ({ key: `skill:${skill.id}`, skill })),
    [filteredSkills],
  );
  const referenceSuggestionIndexes = useMemo(
    () => new Map(referenceSuggestions.map((suggestion, index) => [suggestion.key, index])),
    [referenceSuggestions],
  );
  const activeSuggestionCount = modelMenuOpen
    ? referenceSuggestions.length
    : skillMenuOpen
      ? skillSuggestions.length
      : 0;
  const resolvedActiveSuggestionIndex = activeSuggestionCount > 0
    ? Math.min(activeSuggestionIndex, activeSuggestionCount - 1)
    : 0;

  const selectReferenceSuggestion = useCallback((suggestion: ReferenceSuggestion) => {
    if (suggestion.kind === 'node') {
      insertNodeMention(suggestion.nodeId, suggestion.label, suggestion.displayId);
    } else {
      insertModelMention(suggestion.model);
    }
  }, [insertModelMention, insertNodeMention]);

  const handleSuggestionKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const suggestionsOpen = modelMenuOpen || skillMenuOpen;
    if (!suggestionsOpen) return false;
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return false;
    if (event.key === 'Enter' && event.shiftKey) return false;

    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      setModelMenuOpen(false);
      setSkillMenuOpen(false);
      setModelQuery('');
      setSkillQuery('');
      setReferenceScope('all');
      return true;
    }

    const suggestionCount = modelMenuOpen
      ? referenceSuggestions.length
      : skillSuggestions.length;
    if (suggestionCount === 0) return true;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      setActiveSuggestionIndex((index) => (index + offset + suggestionCount) % suggestionCount);
      return true;
    }

    if (modelMenuOpen) {
      const suggestion = referenceSuggestions[resolvedActiveSuggestionIndex] ?? referenceSuggestions[0];
      if (suggestion) selectReferenceSuggestion(suggestion);
    } else {
      const suggestion = skillSuggestions[resolvedActiveSuggestionIndex] ?? skillSuggestions[0];
      if (suggestion) insertSkillReference(suggestion.skill.id, suggestion.skill.name);
    }
    return true;
  }, [
    insertSkillReference,
    modelMenuOpen,
    referenceSuggestions,
    resolvedActiveSuggestionIndex,
    selectReferenceSuggestion,
    skillMenuOpen,
    skillSuggestions,
  ]);

  const activeSuggestionId = modelMenuOpen
    ? (referenceSuggestions.length > 0
      ? `chat-reference-suggestion-${resolvedActiveSuggestionIndex}`
      : undefined)
    : skillMenuOpen && skillSuggestions.length > 0
      ? `chat-skill-suggestion-${resolvedActiveSuggestionIndex}`
      : undefined;

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

  useEffect(() => {
    const openModelReferences = () => {
      setSkillMenuOpen(false);
      setSkillQuery('');
      setReferenceScope('models');
      setModelQuery('');
      setModelMenuOpen(true);
      setActiveSuggestionIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener('chat-open-reference-menu', openModelReferences);
    return () => window.removeEventListener('chat-open-reference-menu', openModelReferences);
  }, []);

  return (
    <div className="chat-panel-input-area flex-shrink-0 px-3 pt-2">
      <div
        className="chat-panel-input-box relative flex flex-col bg-canvas-card border border-canvas-border
                    rounded-[14px] transition-[border-color,box-shadow] duration-200
                    focus-within:border-brand-light focus-within:ring-2 focus-within:ring-brand/15
                    px-2 py-2"
      >
        {localFileGrants.length > 0 && (
          <div className="mb-2 flex max-h-16 flex-wrap gap-1.5 overflow-y-auto">
            {localFileGrants.map((grant) => (
              <span
                key={grant.id}
                title={`${grant.displayName} · ${Math.ceil(grant.size / 1024)} KB`}
                className="inline-flex items-center gap-1 rounded-full border border-canvas-border/60
                           bg-canvas-hover/70 py-1 pl-2.5 pr-1 text-[11px] leading-none text-canvas-text-secondary"
              >
                <Icon icon="mdi:file-document-outline" width="12" className="shrink-0 text-canvas-text-muted/80" />
                <span className="max-w-[100px] truncate">{grant.displayName}</span>
                {onRevokeLocalFile && (
                  <button
                    type="button"
                    aria-label={`撤销 ${grant.displayName} 的读取授权`}
                    onClick={() => onRevokeLocalFile(grant.id)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-canvas-text-muted transition-colors
                               hover:bg-red-500/15 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50"
                  >
                    <Icon icon="mdi:close" width="11" />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        <ChatComposerEditor
          ref={inputRef}
          value={inputValue}
          onChange={onInputChange}
          onSubmit={onSend}
          nodeDisplayIds={nodeDisplayIds}
          onMentionQueryChange={(query) => {
            setModelMenuOpen(query != null);
            setActiveSuggestionIndex(0);
            const parsedQuery = parseReferenceQuery(query ?? '');
            setReferenceScope(query == null ? 'all' : parsedQuery.scope);
            setModelQuery(parsedQuery.query);
            if (query != null) setSkillMenuOpen(false);
          }}
          onSlashQueryChange={(query) => {
            setSkillMenuOpen(query != null);
            setActiveSuggestionIndex(0);
            setSkillQuery(query ?? '');
            if (query != null) setModelMenuOpen(false);
          }}
          onSuggestionKeyDown={handleSuggestionKeyDown}
          suggestionListId={modelMenuOpen ? REFERENCE_SUGGESTION_LIST_ID : SKILL_SUGGESTION_LIST_ID}
          activeSuggestionId={activeSuggestionId}
          suggestionsOpen={modelMenuOpen || skillMenuOpen}
          placeholder="输入消息，@n 选节点 · @m 选模型 · / 调用 Skill"
          disabled={disabled}
        />

        <div className="chat-panel-input-toolbar flex items-end justify-between gap-3">
          <AnimatePresence>
            {modelMenuOpen && (
            <motion.div
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.97 }}
               transition={reduceMotion
                 ? { duration: 0.1 }
                 : { type: 'spring', visualDuration: 0.22, bounce: 0 }}
               id={REFERENCE_SUGGESTION_LIST_ID}
               role="listbox"
               aria-label="节点与模型引用"
               className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-20 max-h-72 overflow-y-auto rounded-xl border border-canvas-border bg-canvas-surface shadow-xl">
              {visibleCanvasNodes.length > 0 && (
                <div className="px-1 pb-1">
                  <div className="sticky top-0 z-20 -mx-1 flex items-center justify-between bg-canvas-surface px-3 py-1.5 text-[10px] font-medium text-canvas-text-muted">
                    <span>画布节点</span>
                    <span>{visibleCanvasNodes.length}</span>
                  </div>
                  {visibleCanvasNodes.map((node) => {
                    const suggestionIndex = referenceSuggestionIndexes.get(`node:${node.id}`);
                    const active = suggestionIndex === resolvedActiveSuggestionIndex;
                    return (
                      <button
                        key={node.id}
                        id={suggestionIndex == null ? undefined : `chat-reference-suggestion-${suggestionIndex}`}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onMouseEnter={() => suggestionIndex != null && setActiveSuggestionIndex(suggestionIndex)}
                        onClick={() => insertNodeMention(
                          node.id,
                          String(node.data.label || '节点'),
                          node.data.displayId,
                        )}
                        className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] text-canvas-text transition-colors ${active ? 'bg-canvas-hover ring-1 ring-inset ring-indigo-400/25' : 'hover:bg-canvas-hover'}`}
                      >
                        <NodeReferenceThumbnail data={node.data} />
                        <span className="min-w-0 flex-1 truncate">{String(node.data.label || '节点')}</span>
                        {node.data.displayId != null && (
                          <span className="text-[10px] text-canvas-text-muted">#{String(node.data.displayId)}</span>
                        )}
                        <span className="text-[10px] text-canvas-text-muted">{String(node.data.type)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {visibleMediaGroups.map((group) => (
                <div key={group.id} className="px-1 pb-1">
                  <div className="sticky top-0 z-20 -mx-1 flex items-center justify-between bg-canvas-surface px-3 py-1.5 text-[10px] font-medium text-canvas-text-muted">
                    <span>{group.name}</span>
                    <span>{group.models.length}</span>
                  </div>
                  {group.models.map((model) => {
                    const available = isModelAvailable(model);
                    const suggestionIndex = referenceSuggestionIndexes.get(`model:${model.mediaKind}:${model.value}`);
                    const active = suggestionIndex === resolvedActiveSuggestionIndex;
                    return (
                      <button
                        key={`${model.mediaKind}:${model.value}`}
                        id={suggestionIndex == null ? undefined : `chat-reference-suggestion-${suggestionIndex}`}
                        type="button"
                        role="option"
                        aria-selected={active}
                        disabled={!available}
                        onMouseEnter={() => suggestionIndex != null && setActiveSuggestionIndex(suggestionIndex)}
                        onClick={() => insertModelMention(model)}
                        title={available ? model.description : '请先配置对应供应商'}
                        className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] transition-colors ${available ? `text-canvas-text ${active ? 'bg-canvas-hover ring-1 ring-inset ring-indigo-400/25' : 'hover:bg-canvas-hover'}` : 'cursor-not-allowed text-canvas-text-muted opacity-50'}`}
                      >
                        <Icon
                          icon={model.mediaKind === 'image'
                            ? 'mdi:image-outline'
                            : model.mediaKind === 'video'
                              ? 'mdi:video-outline'
                              : 'mdi:music-note-outline'}
                          width="16"
                        />
                        <span className="min-w-0 flex-1 truncate">{model.label}</span>
                        <span className="text-[10px] text-canvas-text-muted">
                          {model.mediaKind === 'image' ? '图片' : model.mediaKind === 'video' ? '视频' : '音频'}
                        </span>
                        {!available && <Icon icon="mdi:lock-outline" width="13" />}
                      </button>
                    );
                  })}
                </div>
              ))}
              {visibleCanvasNodes.length === 0 && visibleMediaGroups.length === 0 && (
                <p className="m-1 px-3 py-3 text-center text-[11px] text-canvas-text-muted">
                  {modelQuery
                    ? `没有匹配"${modelQuery}"的${referenceScope === 'nodes' ? '节点' : referenceScope === 'models' ? '模型' : '节点或模型'}`
                    : referenceScope === 'nodes'
                      ? '暂无可引用的节点'
                      : referenceScope === 'models'
                        ? '暂无可引用的模型'
                        : '暂无可引用的节点或模型'}
                </p>
              )}
            </motion.div>
          )}
          </AnimatePresence>
          <AnimatePresence>
            {skillMenuOpen && (
            <motion.div
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.97 }}
               transition={reduceMotion
                 ? { duration: 0.1 }
                 : { type: 'spring', visualDuration: 0.22, bounce: 0 }}
               id={SKILL_SUGGESTION_LIST_ID}
               role="listbox"
               aria-label="Skill 引用"
               className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-20 max-h-72 overflow-y-auto rounded-xl border border-canvas-border bg-canvas-surface shadow-xl">
              <div className="sticky top-0 z-20 flex items-center justify-between bg-canvas-surface px-3 py-1.5 text-[10px] font-medium text-canvas-text-muted">
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
                    className="flex h-7 w-7 items-center justify-center rounded-md text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text
                               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50 disabled:cursor-wait disabled:opacity-50"
                  >
                    <Icon icon={skillUploading ? 'mdi:loading' : 'mdi:plus'} width="15" className={skillUploading ? 'animate-spin' : ''} />
                  </button>
                </span>
              </div>
              <div className="px-1 pb-1">
                {filteredSkills.length > 0 ? filteredSkills.map((skill, skillIndex) => (
                  <button
                    key={skill.id}
                    id={`chat-skill-suggestion-${skillIndex}`}
                    type="button"
                    role="option"
                    aria-selected={skillIndex === resolvedActiveSuggestionIndex}
                    onMouseEnter={() => setActiveSuggestionIndex(skillIndex)}
                    onClick={() => insertSkillReference(skill.id, skill.name)}
                    title={skill.description}
                    className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] text-canvas-text transition-colors ${skillIndex === resolvedActiveSuggestionIndex ? 'bg-canvas-hover ring-1 ring-inset ring-indigo-400/25' : 'hover:bg-canvas-hover'}`}
                  >
                    <Icon icon="mdi:puzzle-outline" width="16" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{skill.name}</span>
                      <span className="block truncate text-[10px] text-canvas-text-muted">{skill.description}</span>
                    </span>
                  </button>
                )) : (
                  <p className="px-3 py-3 text-center text-[11px] text-canvas-text-muted">
                    {skillQuery ? `没有匹配"${skillQuery}"的 Skill` : '暂无已上传 Skill'}
                  </p>
                )}
              </div>
            </motion.div>
          )}
          </AnimatePresence>

          <div className="flex items-center gap-1.5 min-w-0">
            <ModelSelector
              nodeType="ai-text"
              selectedModel={selectedTextModel}
              onSelect={handleTextModelSelect}
              generalModelsOverride={mediaModels}
              groupAvailability={modelGroupAvailability}
            />
          </div>

          <div className="flex items-end gap-1.5 shrink-0">
            <div className="flex items-center gap-px">
              <button
                type="button"
                onClick={() => {
                  setModelQuery('');
                  setReferenceScope('all');
                  setSkillMenuOpen(false);
                  setActiveSuggestionIndex(0);
                  setModelMenuOpen((open) => !open);
                  inputRef.current?.focus();
                }}
                aria-label="引用画布节点或媒体模型"
                title="引用画布节点或媒体模型"
                className={`flex h-7 w-7 items-center justify-center rounded-md transition-[color,background-color,box-shadow]
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50
                  ${modelMenuOpen
                    ? 'bg-brand/15 text-brand-light'
                    : 'text-canvas-text-secondary hover:bg-canvas-surface hover:text-canvas-text'
                  }`}
              >
                <Icon icon="mdi:at" width="14" />
              </button>
              <span className="w-px h-3.5 bg-canvas-border/50" aria-hidden="true" />
              <button
                type="button"
                onClick={() => {
                  setSkillQuery('');
                  setModelMenuOpen(false);
                  setActiveSuggestionIndex(0);
                  setSkillMenuOpen((open) => !open);
                  inputRef.current?.focus();
                }}
                aria-label="调用 Skill"
                title="调用 Skill"
                className={`flex h-7 w-7 items-center justify-center rounded-md transition-[color,background-color,box-shadow]
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50
                  ${skillMenuOpen
                    ? 'bg-brand/15 text-brand-light'
                    : 'text-canvas-text-secondary hover:bg-canvas-surface hover:text-canvas-text'
                  }`}
              >
                <Icon icon="mdi:slash-forward" width="14" />
              </button>
              {onAuthorizeLocalFiles && (
                <>
                  <span className="w-px h-3.5 bg-canvas-border/50" aria-hidden="true" />
                  <button
                    type="button"
                    onClick={onAuthorizeLocalFiles}
                    aria-label="授权当前对话读取本地文件"
                    title="选择文本文件；授权仅在当前对话和本次运行期间有效"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-canvas-text-secondary
                               hover:bg-canvas-surface hover:text-canvas-text transition-[color,background-color,box-shadow]
                               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
                  >
                    <Icon icon="mdi:paperclip" width="14" />
                  </button>
                </>
              )}
            </div>
            {inputValue.trim() && !disabled && (
              <span className="hidden sm:inline text-[11px] text-canvas-text-muted/60 tabular-nums select-none">
                ↵ Enter
              </span>
            )}
            <div className="flex h-7 w-7 items-center justify-center">
              <ContextUsageIndicator usage={contextUsage ?? null} />
            </div>

            {hasActiveTask && onInterject && inputValue.trim() && !disabled && (
              <button
                type="button"
                onClick={onInterject}
                aria-label="调整当前任务"
                title="在下一个安全步骤调整当前任务"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-canvas-border
                           bg-canvas-surface text-canvas-text-secondary transition-[color,background-color,border-color]
                           hover:border-brand/40 hover:bg-brand/10 hover:text-brand-light
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300/70"
              >
                <Icon icon="mdi:source-branch-sync" width="16" height="16" />
              </button>
            )}

            <AnimatedButton
              scale={1.05}
              disabled={!inputValue.trim() || disabled}
              aria-label={hasActiveTask ? '将消息加入队列' : '发送消息'}
              title={hasActiveTask ? '当前任务完成后发送' : '发送消息'}
              className={`chat-panel-send-btn flex shrink-0 items-center justify-center h-8 w-8 rounded-full
                          transition-[color,background-color,box-shadow,opacity,transform] duration-200 active:scale-95
                          motion-reduce:transform-none
                          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300/70
                          ${inputValue.trim() && !disabled
                            ? 'bg-brand text-white hover:bg-brand-light shadow-lg shadow-brand/30'
                            : 'bg-canvas-hover text-canvas-text-muted cursor-not-allowed'
                          }`}
              onClick={onSend}
            >
              <Icon icon={hasActiveTask ? 'mdi:playlist-plus' : 'mdi:arrow-up'} width="18" height="18" />
            </AnimatedButton>
          </div>
        </div>
      </div>

      {/* Disclaimer */}
      <div className="flex min-h-5 items-center justify-center">
        <p className="chat-panel-disclaimer text-[11px] text-canvas-text-muted/75">
          重要操作执行前会请求确认
        </p>
      </div>
    </div>
  );
}
