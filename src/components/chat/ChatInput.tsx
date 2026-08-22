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
import MentionPicker, { type MentionPickerItem } from '../shared/MentionPicker';
import { resolveDramaMentionItems } from '../nodes/shared/mentionEditorSources';
import { bestNodeThumb } from '../nodes/shared/mentionEditorDom';
import type { BaseNodeData, GeneralModelConfig, ModelOption } from '../../types';
import type { ContextUsageStat } from '../../services/chat/contextManager';
import { useAppStore } from '../../store/useAppStore';
import { useT } from '../../i18n';
import { isSkillUserInvocable } from '../../services/skillPromptService';
import {
  type MediaModelOption,
} from '../nodes/shared/defaultModels';
import type { LocalFileGrantSummary } from '../../services/chat/fileGrantService';

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
type ReferenceScope = 'all' | 'nodes' | 'models' | 'assets';
type PickerTab = 'nodes' | 'assets' | 'models';
const PICKER_TAB_ORDER: readonly PickerTab[] = ['nodes', 'assets', 'models'];
type DramaMentionItem = ReturnType<typeof resolveDramaMentionItems>[number];
type ReferenceSuggestion =
  | { key: string; kind: 'node'; nodeId: string; label: string; displayId?: number }
  | { key: string; kind: 'drama'; item: DramaMentionItem }
  | { key: string; kind: 'model'; model: MediaModelOption };

const DRAMA_KIND_LABELS: Record<string, string> = { character: '角色', scene: '场景', prop: '道具' };
const TAB_NOUNS: Record<PickerTab, string> = { nodes: '节点', assets: '资产', models: '模型' };

const MEDIA_KIND_LABELS: Record<string, string> = { image: '图片', video: '视频', audio: '音频' };
const MEDIA_KIND_ICONS: Record<string, string> = {
  image: 'mdi:image-outline',
  video: 'mdi:video-outline',
  audio: 'mdi:music-note-outline',
};

const REFERENCE_SUGGESTION_LIST_ID = 'chat-reference-suggestions';
const SKILL_SUGGESTION_LIST_ID = 'chat-skill-suggestions';

function parseReferenceQuery(query: string): { scope: ReferenceScope; query: string } {
  const shortcut = query.toLocaleLowerCase();
  if (shortcut === 'n') return { scope: 'nodes', query: '' };
  if (shortcut === 'm') return { scope: 'models', query: '' };
  if (shortcut === 'a') return { scope: 'assets', query: '' };
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
  /** 独立窗口是只读镜像，上传只会写进本窗口 Store 并被下一帧同步覆盖 */
  allowSkillUpload?: boolean;
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
  allowSkillUpload = true,
}: ChatInputProps) {
  const t = useT();
  const inputRef = useRef<ChatComposerEditorHandle>(null);
  const reduceMotion = useReducedMotion();
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [pickerTab, setPickerTab] = useState<PickerTab>('nodes');
  const [mediaKind, setMediaKind] = useState<string>('all');
  const [assetKind, setAssetKind] = useState<string>('all');
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState('');
  const [skillUploading, setSkillUploading] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const canvasNodes = useAppStore((state) => state.nodes);
  const dramaAssets = useAppStore((state) => state.dramaAssets);
  const userSkills = useAppStore((state) => state.userSkills);
  const uploadSkill = useAppStore((state) => state.uploadSkill);
  const showToast = useAppStore((state) => state.showToast);
  const compatibleMediaModels = mediaModelOptions;
  const filteredMediaModels = useMemo(
    () => compatibleMediaModels.filter((model) => fuzzyMatchModel(model, modelQuery)),
    [compatibleMediaModels, modelQuery],
  );
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
  // 媒体模型按类型分档，作为「模型」Tab 的筛选芯片
  const mediaKindChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of filteredMediaModels) {
      counts.set(model.mediaKind, (counts.get(model.mediaKind) ?? 0) + 1);
    }
    if (counts.size === 0) return [];
    return [
      { id: 'all', label: t('全部'), count: filteredMediaModels.length },
      ...[...counts].map(([kind, count]) => ({ id: kind, label: t(MEDIA_KIND_LABELS[kind] ?? kind), count })),
    ];
  }, [filteredMediaModels, t]);
  const kindedMediaModels = useMemo(
    () => (mediaKind === 'all' ? filteredMediaModels : filteredMediaModels.filter((m) => m.mediaKind === mediaKind)),
    [filteredMediaModels, mediaKind],
  );
  // 资产库（短剧人物/场景/道具），与节点提示词的 @ 用同一份数据源
  const filteredDramaAssets = useMemo(
    () => resolveDramaMentionItems(dramaAssets, modelQuery),
    [dramaAssets, modelQuery],
  );
  const assetKindChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of filteredDramaAssets) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    if (counts.size === 0) return [];
    return [
      { id: 'all', label: t('全部'), count: filteredDramaAssets.length },
      ...[...counts].map(([kind, count]) => ({ id: kind, label: t(DRAMA_KIND_LABELS[kind] ?? kind), count })),
    ];
  }, [filteredDramaAssets, t]);
  const kindedDramaAssets = useMemo(
    () => (assetKind === 'all' ? filteredDramaAssets : filteredDramaAssets.filter((a) => a.kind === assetKind)),
    [assetKind, filteredDramaAssets],
  );

  // 当前 Tab 空而别的 Tab 有内容时自动切过去（输入 @关键词 时不至于对着空网格）
  const tabCounts: Record<PickerTab, number> = {
    nodes: filteredCanvasNodes.length,
    assets: filteredDramaAssets.length,
    models: filteredMediaModels.length,
  };
  const effectiveTab: PickerTab = tabCounts[pickerTab] > 0
    ? pickerTab
    : PICKER_TAB_ORDER.find((tab) => tabCounts[tab] > 0) ?? pickerTab;
  const visibleCanvasNodes = useMemo(
    () => effectiveTab === 'nodes' ? filteredCanvasNodes : [],
    [filteredCanvasNodes, effectiveTab],
  );
  const visibleDramaAssets = useMemo(
    () => effectiveTab === 'assets' ? kindedDramaAssets : [],
    [effectiveTab, kindedDramaAssets],
  );
  const visibleMediaModels = useMemo(
    () => effectiveTab === 'models' ? kindedMediaModels : [],
    [kindedMediaModels, effectiveTab],
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
    setPickerTab('nodes');
    setMediaKind('all');
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
    setPickerTab('nodes');
    setMediaKind('all');
    setActiveSuggestionIndex(0);
  }, []);

  // 资产芯片走 @drama{id:name}，发送前由 promptResolver 展开成设定正文或参考图
  const insertDramaMention = useCallback((item: DramaMentionItem) => {
    inputRef.current?.insertReference({ kind: 'drama', id: item.id, label: item.name });
    setModelMenuOpen(false);
    setModelQuery('');
    setPickerTab('nodes');
    setAssetKind('all');
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
      label: String(node.data.label || t('节点')),
      displayId: node.data.displayId,
    })),
    ...visibleDramaAssets.map((item) => ({
      key: `drama:${item.id}`,
      kind: 'drama' as const,
      item,
    })),
    ...visibleMediaModels
      .filter(isModelAvailable)
      .map((model) => ({
        key: `model:${model.mediaKind}:${model.value}`,
        kind: 'model' as const,
        model,
      })),
  ], [isModelAvailable, t, visibleCanvasNodes, visibleDramaAssets, visibleMediaModels]);
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
    } else if (suggestion.kind === 'drama') {
      insertDramaMention(suggestion.item);
    } else {
      insertModelMention(suggestion.model);
    }
  }, [insertDramaMention, insertModelMention, insertNodeMention]);

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
      setPickerTab('nodes');
      setMediaKind('all');
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

  // @ 面板卡片：先节点后模型，顺序与 referenceSuggestions 一致，键盘高亮才对得上
  const referenceItems: MentionPickerItem[] = [
    ...visibleCanvasNodes.map((node) => {
      const label = String(node.data.label || t('节点'));
      const index = referenceSuggestionIndexes.get(`node:${node.id}`);
      return {
        key: `node:${node.id}`,
        domId: index == null ? undefined : `chat-reference-suggestion-${index}`,
        label,
        thumbnailUrl: resolveNodeThumbnail(node.data),
        badge: node.data.displayId != null ? `#${String(node.data.displayId)}` : undefined,
        title: `${label} · ${String(node.data.type)}`,
        onSelect: () => insertNodeMention(node.id, label, node.data.displayId),
      };
    }),
    ...visibleDramaAssets.map((item) => {
      const index = referenceSuggestionIndexes.get(`drama:${item.id}`);
      const boundNode = item.imageNodeId ? canvasNodes.find((n) => n.id === item.imageNodeId) : undefined;
      const thumbnailUrl = (boundNode ? bestNodeThumb(boundNode.data) : undefined)
        || item.imageUrl
        || item.referenceImages?.find((reference) => !!reference.imageUrl)?.imageUrl;
      return {
        key: `drama:${item.id}`,
        domId: index == null ? undefined : `chat-reference-suggestion-${index}`,
        label: item.name,
        thumbnailUrl,
        icon: 'mdi:account-box-outline',
        badge: t(DRAMA_KIND_LABELS[item.kind] ?? item.kind),
        title: thumbnailUrl ? t('{name}（引用参考图）', { name: item.name }) : t('{name}（引用设定文字）', { name: item.name }),
        onSelect: () => insertDramaMention(item),
      };
    }),
    ...visibleMediaModels.map((model) => {
      const available = isModelAvailable(model);
      const index = referenceSuggestionIndexes.get(`model:${model.mediaKind}:${model.value}`);
      return {
        key: `model:${model.mediaKind}:${model.value}`,
        domId: index == null ? undefined : `chat-reference-suggestion-${index}`,
        label: model.label,
        icon: MEDIA_KIND_ICONS[model.mediaKind],
        badge: available ? t(MEDIA_KIND_LABELS[model.mediaKind]) : t('未配置'),
        disabled: !available,
        title: available ? model.description : t('请先配置对应供应商'),
        onSelect: () => insertModelMention(model),
      };
    }),
  ];

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
      showToast(error instanceof Error ? error.message : t('上传 Skill 失败'), 'error');
    } finally {
      setSkillUploading(false);
    }
  }, [showToast, skillUploading, t, uploadSkill]);

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
      setPickerTab('models');
      setMediaKind('all');
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
                    px-1.5 py-1.5"
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
                    aria-label={t('撤销 {name} 的读取授权', { name: grant.displayName })}
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
            // @n / @a / @m 直接落到对应 Tab；关闭时归位到「节点」
            if (query == null || parsedQuery.scope === 'nodes') setPickerTab('nodes');
            else if (parsedQuery.scope === 'assets') setPickerTab('assets');
            else if (parsedQuery.scope === 'models') setPickerTab('models');
            if (query == null) { setMediaKind('all'); setAssetKind('all'); }
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
          placeholder={t('输入消息，@n 节点 · @a 资产 · @m 模型 · / 调用 Skill')}
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
              className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-20"
            >
              <MentionPicker
                listId={REFERENCE_SUGGESTION_LIST_ID}
                ariaLabel={t('节点与模型引用')}
                tabs={[
                  { id: 'nodes', label: t('画布节点'), icon: 'mdi:image-multiple-outline' },
                  { id: 'assets', label: t('资产库'), icon: 'mdi:bookshelf' },
                  { id: 'models', label: t('模型'), icon: 'mdi:cube-outline' },
                ]}
                activeTab={effectiveTab}
                onTabChange={(id) => {
                  setPickerTab(id as PickerTab);
                  setActiveSuggestionIndex(0);
                }}
                chips={effectiveTab === 'models'
                  ? mediaKindChips
                  : effectiveTab === 'assets' ? assetKindChips : undefined}
                activeChip={effectiveTab === 'assets' ? assetKind : mediaKind}
                onChipChange={(id) => {
                  if (effectiveTab === 'assets') setAssetKind(id);
                  else setMediaKind(id);
                  setActiveSuggestionIndex(0);
                }}
                items={referenceItems}
                activeKey={referenceSuggestions[resolvedActiveSuggestionIndex]?.key}
                onItemHover={(key) => {
                  const index = referenceSuggestionIndexes.get(key);
                  if (index != null) setActiveSuggestionIndex(index);
                }}
                emptyText={modelQuery
                  ? t('没有匹配"{query}"的{noun}', { query: modelQuery, noun: t(TAB_NOUNS[effectiveTab]) })
                  : t('暂无可引用的{noun}', { noun: t(TAB_NOUNS[effectiveTab]) })}
              />
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
               aria-label={t('Skill 引用')}
               className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-20 max-h-72 overflow-y-auto rounded-xl border border-canvas-border bg-canvas-surface shadow-xl">
              <div className="sticky top-0 z-20 flex items-center justify-between bg-canvas-surface px-3 py-1.5 text-[10px] font-medium text-canvas-text-muted">
                <span>Skill</span>
                <span className="flex items-center gap-2">
                  <span>{filteredSkills.length}</span>
                  {allowSkillUpload && (
                  <button
                    type="button"
                    disabled={skillUploading}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleUploadSkill();
                    }}
                    aria-label={t('上传 Skill')}
                    title={t('上传 Skill 文件')}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text
                               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50 disabled:cursor-wait disabled:opacity-50"
                  >
                    <Icon icon={skillUploading ? 'mdi:loading' : 'mdi:plus'} width="15" className={skillUploading ? 'animate-spin' : ''} />
                  </button>
                  )}
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
                    {skillQuery ? t('没有匹配"{query}"的 Skill', { query: skillQuery }) : t('暂无已上传 Skill')}
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
                  setPickerTab('nodes');
                  setMediaKind('all');
                  setSkillMenuOpen(false);
                  setActiveSuggestionIndex(0);
                  setModelMenuOpen((open) => !open);
                  inputRef.current?.focus();
                }}
                aria-label={t('引用画布节点或媒体模型')}
                title={t('引用画布节点或媒体模型')}
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
                aria-label={t('调用 Skill')}
                title={t('调用 Skill')}
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
                    aria-label={t('授权当前对话读取本地文件')}
                    title={t('选择文本文件；授权仅在当前对话和本次运行期间有效')}
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
                aria-label={t('调整当前任务')}
                title={t('在下一个安全步骤调整当前任务')}
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
              aria-label={hasActiveTask ? t('将消息加入队列') : t('发送消息')}
              title={hasActiveTask ? t('当前任务完成后发送') : t('发送消息')}
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
          {t('重要操作执行前会请求确认')}
        </p>
      </div>
    </div>
  );
}
