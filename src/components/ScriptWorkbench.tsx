import { useId, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import type { EpisodeCreativeInfo } from '../types';
import { useAppStore } from '../store/useAppStore';
import { listEpisodes, seriesOwnerId } from '../store/store.utils';
import {
  analyzeEpisodeScript,
  buildCreativeFieldPolishPrompt,
  buildEpisodeCreativePrompt,
  buildSplitDraftPrompt,
  type CreativeFieldId,
  type EpisodeCreativeAction,
} from '../services/seriesCreativeService';
import { useT } from '../i18n';
import ModalOverlay from './shared/ModalOverlay';
import PopupCloseButton from './shared/PopupCloseButton';

type EditorTab = 'outline' | 'script' | 'creative';
type PendingAction = { type: 'close' } | { type: 'switch'; episodeId: string };

interface CreativeDraft {
  task: string;
  coreConflict: string;
  openingHook: string;
  reversal: string;
  endingHook: string;
  beats: string;
  targetDurationSec: string;
  sourceRange: string;
}

interface WorkbenchDraft {
  outline: string;
  script: string;
  creative: CreativeDraft;
}

const EMPTY_CREATIVE_DRAFT: CreativeDraft = {
  task: '',
  coreConflict: '',
  openingHook: '',
  reversal: '',
  endingHook: '',
  beats: '',
  targetDurationSec: '',
  sourceRange: '',
};

const CREATIVE_ACTION_GROUPS: Array<{
  label: string;
  icon: string;
  actions: Array<{ id: EpisodeCreativeAction; label: string }>;
}> = [
  {
    label: '结构创作',
    icon: 'lucide:blocks',
    actions: [
      { id: 'optimize-outline', label: '优化本集大纲' },
      { id: 'adjust-beats', label: '调整情节点' },
      { id: 'diagnose', label: '深度创作诊断' },
    ],
  },
  {
    label: '剧本写作',
    icon: 'lucide:pen-line',
    actions: [
      { id: 'write-script', label: '根据集纲写正文' },
      { id: 'rewrite-script', label: '重写本集剧本' },
      { id: 'polish-dialogue', label: '对白润色' },
      { id: 'visualize-action', label: '动作可拍化' },
    ],
  },
  {
    label: '戏剧增强',
    icon: 'lucide:sparkles',
    actions: [
      { id: 'strengthen-opening', label: '加强开场钩子' },
      { id: 'strengthen-conflict', label: '加强核心冲突' },
      { id: 'design-reversal', label: '设计反转' },
      { id: 'strengthen-ending', label: '加强结尾卡点' },
      { id: 'add-performance-cues', label: '补表演标注' },
    ],
  },
];

function toCreativeDraft(value: EpisodeCreativeInfo | undefined): CreativeDraft {
  return {
    ...EMPTY_CREATIVE_DRAFT,
    task: value?.task ?? '',
    coreConflict: value?.coreConflict ?? '',
    openingHook: value?.openingHook ?? '',
    reversal: value?.reversal ?? '',
    endingHook: value?.endingHook ?? '',
    beats: value?.beats?.join('\n') ?? '',
    targetDurationSec: value?.targetDurationSec ? String(value.targetDurationSec) : '90',
    sourceRange: value?.sourceRange ?? '',
  };
}

function toCreativeInfo(value: CreativeDraft): EpisodeCreativeInfo | undefined {
  const duration = Number.parseInt(value.targetDurationSec, 10);
  const beats = value.beats
    .split(/\r?\n/)
    .map((beat) => beat.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, '').trim())
    .filter(Boolean);
  const result: EpisodeCreativeInfo = {
    task: value.task.trim() || undefined,
    coreConflict: value.coreConflict.trim() || undefined,
    openingHook: value.openingHook.trim() || undefined,
    reversal: value.reversal.trim() || undefined,
    endingHook: value.endingHook.trim() || undefined,
    beats: beats.length > 0 ? beats : undefined,
    targetDurationSec: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    sourceRange: value.sourceRange.trim() || undefined,
  };
  return Object.values(result).some((item) => item !== undefined) ? result : undefined;
}

function createDraft(episode: {
  episodeOutline?: string;
  episodeScript?: string;
  episodeCreative?: EpisodeCreativeInfo;
} | null): WorkbenchDraft {
  return {
    outline: episode?.episodeOutline ?? '',
    script: episode?.episodeScript ?? '',
    creative: toCreativeDraft(episode?.episodeCreative),
  };
}

function draftSignature(value: WorkbenchDraft): string {
  return JSON.stringify(value);
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-canvas-border bg-canvas-card px-2.5 py-2">
      <p className="truncate text-[10px] text-canvas-text-muted">{label}</p>
      <p className="mt-0.5 truncate text-xs font-semibold text-canvas-text">{value}</p>
    </div>
  );
}

function CreativeField({
  label,
  value,
  placeholder,
  multiline = false,
  onChange,
  onAiAction,
  aiDisabled = false,
}: {
  label: string;
  value: string;
  placeholder: string;
  multiline?: boolean;
  onChange: (value: string) => void;
  onAiAction?: () => void;
  aiDisabled?: boolean;
}) {
  const t = useT();
  const inputId = useId();
  const aiActionLabel = value.trim() ? t('AI 润色') : t('AI 生成');
  const fieldClass = `w-full rounded-lg border border-canvas-border bg-canvas-card px-3 text-xs
                      text-canvas-text outline-none transition-colors placeholder:text-canvas-text-muted
                      focus:border-indigo-400/60 focus:ring-1 focus:ring-indigo-400/20`;
  return (
    <div className="grid min-w-0 gap-1.5">
      <span className="flex min-w-0 items-center gap-2">
        <label
          htmlFor={inputId}
          className="min-w-0 flex-1 truncate text-[11px] font-medium text-canvas-text-secondary"
        >
          {label}
        </label>
        {onAiAction ? (
          <button
            type="button"
            disabled={aiDisabled}
            onClick={(event) => {
              event.preventDefault();
              onAiAction();
            }}
            aria-label={t('{action}{label}', { action: aiActionLabel, label })}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-indigo-400/20
                       bg-indigo-500/10 px-2 text-[10px] font-medium text-indigo-300 transition-colors
                       hover:border-indigo-400/40 hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon icon="lucide:sparkles" className="h-3 w-3" />
            {aiActionLabel}
          </button>
        ) : null}
      </span>
      {multiline ? (
        <textarea
          id={inputId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={`${fieldClass} min-h-24 resize-y py-2.5 leading-relaxed`}
        />
      ) : (
        <input
          id={inputId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={`${fieldClass} h-9`}
        />
      )}
    </div>
  );
}

export default function ScriptWorkbench({
  isOpen,
  onClose,
  startWithSplit = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  startWithSplit?: boolean;
}) {
  const t = useT();
  const {
    projects,
    currentProjectId,
    projectLoadStatus,
    switchProject,
    updateEpisodeCreative,
    openChatWithDraft,
    showToast,
  } = useAppStore(useShallow((state) => ({
    projects: state.projects,
    currentProjectId: state.currentProjectId,
    projectLoadStatus: state.projectLoadStatus,
    switchProject: state.switchProject,
    updateEpisodeCreative: state.updateEpisodeCreative,
    openChatWithDraft: state.openChatWithDraft,
    showToast: state.showToast,
  })));

  const seriesId = currentProjectId ? seriesOwnerId(projects, currentProjectId) : null;
  const series = projects.find((project) => project.id === seriesId) ?? null;
  const episodes = useMemo(
    () => (seriesId ? listEpisodes(projects, seriesId) : []),
    [projects, seriesId],
  );
  const currentEpisode = episodes.find((episode) => episode.id === currentProjectId)
    ?? episodes[0]
    ?? null;
  const [activeTab, setActiveTab] = useState<EditorTab>('outline');
  const [draftsByEpisode, setDraftsByEpisode] = useState<Record<string, WorkbenchDraft>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [splitOpen, setSplitOpen] = useState(startWithSplit);
  const [splitSource, setSplitSource] = useState<'script' | 'original'>(
    series?.series?.script?.trim() ? 'script' : 'original',
  );
  const [targetEpisodeCount, setTargetEpisodeCount] = useState('24');
  const [targetDurationSec, setTargetDurationSec] = useState('90');
  const splitSourceAvailable = splitSource === 'script'
    ? Boolean(series?.series?.script?.trim())
    : Boolean(series?.series?.originalWork);

  const persistedDraft = createDraft(currentEpisode);
  const draft = currentEpisode
    ? draftsByEpisode[currentEpisode.id] ?? persistedDraft
    : persistedDraft;
  const isDirty = currentEpisode !== null
    && draftsByEpisode[currentEpisode.id] !== undefined
    && draftSignature(draft) !== draftSignature(persistedDraft);
  const analysis = useMemo(
    () => analyzeEpisodeScript(draft.script, toCreativeInfo(draft.creative)),
    [draft.creative, draft.script],
  );

  const saveDraft = async (): Promise<boolean> => {
    if (!currentEpisode || isSaving || projectLoadStatus !== 'ready') return false;
    setIsSaving(true);
    try {
      const saved = await updateEpisodeCreative(currentEpisode.id, {
        outline: draft.outline,
        script: draft.script,
        creative: toCreativeInfo(draft.creative),
      });
      if (saved) {
        setDraftsByEpisode((current) => {
          const next = { ...current };
          delete next[currentEpisode.id];
          return next;
        });
      }
      return saved;
    } finally {
      setIsSaving(false);
    }
  };

  const performPendingAction = (action: PendingAction) => {
    setPendingAction(null);
    if (currentEpisode) {
      setDraftsByEpisode((current) => {
        const next = { ...current };
        delete next[currentEpisode.id];
        return next;
      });
    }
    if (action.type === 'close') {
      onClose();
      return;
    }
    void switchProject(action.episodeId);
  };

  const requestClose = () => {
    if (isDirty) setPendingAction({ type: 'close' });
    else onClose();
  };

  const requestEpisodeSwitch = (episodeId: string) => {
    if (episodeId === currentEpisode?.id) return;
    if (isDirty) setPendingAction({ type: 'switch', episodeId });
    else void switchProject(episodeId);
  };

  const openCreativeAction = async (action: EpisodeCreativeAction) => {
    if (!series || !currentEpisode) return;
    if (isDirty && !await saveDraft()) return;
    openChatWithDraft(buildEpisodeCreativePrompt(action, {
      seriesName: series.name,
      episodeId: currentEpisode.id,
      episodeName: currentEpisode.name,
    }));
    showToast(t('已把创作请求放入对话输入框'));
  };

  const openFieldPolish = async (field: CreativeFieldId, label: string, hasValue: boolean) => {
    if (!series || !currentEpisode) return;
    if (isDirty && !await saveDraft()) return;
    openChatWithDraft(buildCreativeFieldPolishPrompt(field, {
      seriesName: series.name,
      episodeId: currentEpisode.id,
      episodeName: currentEpisode.name,
    }, hasValue));
    showToast(t('已准备{name}的 AI 创作请求', { name: label }));
  };

  const openSplitDraft = () => {
    if (!series) return;
    const count = Math.min(100, Math.max(1, Number.parseInt(targetEpisodeCount, 10) || 24));
    const duration = Math.min(600, Math.max(15, Number.parseInt(targetDurationSec, 10) || 90));
    openChatWithDraft(buildSplitDraftPrompt({
      seriesName: series.name,
      source: splitSource,
      targetEpisodeCount: count,
      targetDurationSec: duration,
      existingEpisodeCount: episodes.length,
    }));
    showToast(t('已准备拆分草案请求，不会直接创建分集'));
  };

  const setCreative = (field: keyof CreativeDraft, value: string) => {
    if (!currentEpisode) return;
    setDraftsByEpisode((current) => {
      const currentDraft = current[currentEpisode.id] ?? createDraft(currentEpisode);
      return {
        ...current,
        [currentEpisode.id]: {
          ...currentDraft,
          creative: { ...currentDraft.creative, [field]: value },
        },
      };
    });
  };

  const setTextDraft = (field: 'outline' | 'script', value: string) => {
    if (!currentEpisode) return;
    setDraftsByEpisode((current) => {
      const currentDraft = current[currentEpisode.id] ?? createDraft(currentEpisode);
      return {
        ...current,
        [currentEpisode.id]: { ...currentDraft, [field]: value },
      };
    });
  };

  return (
    <ModalOverlay
      isOpen={isOpen}
      onClose={requestClose}
      ariaLabel={t('剧本创作工作台')}
      closeOnBackdrop={false}
      className="h-[min(88vh,860px)] w-[min(1180px,calc(100vw-24px))]
                 border-[var(--glass-ring)] bg-[var(--glass-bg)] text-canvas-text"
    >
      <div
        className="flex min-h-0 flex-1 flex-col"
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            void saveDraft();
          }
        }}
      >
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border-subtle px-4">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-indigo-500/15 text-indigo-400">
            <Icon icon="lucide:notebook-pen" className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{t('剧本创作工作台')}</h2>
            <p className="truncate text-[11px] text-canvas-text-muted">
              {series?.name ?? t('当前剧集')} · {currentEpisode?.name ?? t('还没有分集')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setSplitOpen((open) => !open)}
            className={`flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs transition-colors ${
              splitOpen
                ? 'border-indigo-400/50 bg-indigo-500/15 text-indigo-300'
                : 'border-canvas-border text-canvas-text-secondary hover:bg-canvas-hover'
            }`}
          >
            <Icon icon="lucide:wand-sparkles" className="h-3.5 w-3.5" />
            {t('AI 拆分草案')}
          </button>
          <PopupCloseButton ariaLabel={t('关闭剧本创作工作台')} onClick={requestClose} />
        </header>

        {pendingAction ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-400/20 bg-amber-500/10 px-4 py-2">
            <Icon icon="lucide:triangle-alert" className="h-4 w-4 text-amber-400" />
            <span className="min-w-0 flex-1 text-xs text-amber-100">
              {t('当前修改还没有保存，要先保存吗？')}
            </span>
            <button
              type="button"
              onClick={() => setPendingAction(null)}
              className="h-7 rounded-md px-2.5 text-[11px] text-canvas-text-secondary hover:bg-canvas-hover"
            >
              {t('继续编辑')}
            </button>
            <button
              type="button"
              onClick={() => performPendingAction(pendingAction)}
              className="h-7 rounded-md px-2.5 text-[11px] text-red-300 hover:bg-red-500/15"
            >
              {t('放弃修改')}
            </button>
            <button
              type="button"
              disabled={isSaving}
              onClick={() => {
                void saveDraft().then((saved) => {
                  if (saved) performPendingAction(pendingAction);
                });
              }}
              className="h-7 rounded-md bg-amber-400/90 px-3 text-[11px] font-medium text-black
                         hover:bg-amber-300 disabled:cursor-wait disabled:opacity-60"
            >
              {t('保存并继续')}
            </button>
          </div>
        ) : null}

        {splitOpen ? (
          <section className="grid shrink-0 gap-3 border-b border-border-subtle bg-canvas-card/40 p-3
                              sm:grid-cols-[minmax(0,1fr)_120px_120px_auto] sm:items-end">
            <label className="grid gap-1">
              <span className="text-[10px] text-canvas-text-muted">{t('拆分素材')}</span>
              <select
                value={splitSource}
                onChange={(event) => setSplitSource(event.target.value as 'script' | 'original')}
                className="h-8 rounded-lg border border-canvas-border bg-canvas-card px-2 text-xs outline-none"
              >
                <option value="script">{t('全剧剧本')}</option>
                <option value="original">{t('原著')}</option>
              </select>
            </label>
            <label className="grid gap-1">
              <span className="text-[10px] text-canvas-text-muted">{t('目标总集数')}</span>
              <input
                type="number"
                min={1}
                max={100}
                value={targetEpisodeCount}
                onChange={(event) => setTargetEpisodeCount(event.target.value)}
                className="h-8 rounded-lg border border-canvas-border bg-canvas-card px-2 text-xs outline-none"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-[10px] text-canvas-text-muted">{t('单集秒数')}</span>
              <input
                type="number"
                min={15}
                max={600}
                value={targetDurationSec}
                onChange={(event) => setTargetDurationSec(event.target.value)}
                className="h-8 rounded-lg border border-canvas-border bg-canvas-card px-2 text-xs outline-none"
              />
            </label>
            <button
              type="button"
              disabled={!splitSourceAvailable}
              onClick={openSplitDraft}
              className="flex h-8 items-center justify-center gap-1.5 rounded-lg bg-indigo-500/90 px-3
                         text-xs font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed
                         disabled:opacity-40"
            >
              <Icon icon="lucide:message-square-text" className="h-3.5 w-3.5" />
              {t('在对话中生成预览')}
            </button>
            <p className="text-[10px] text-canvas-text-muted sm:col-span-4">
              {splitSourceAvailable
                ? t('只生成可调整的分集草案，不会直接创建、覆盖或删除分集。')
                : t('请先添加所选素材，再生成拆分草案。')}
            </p>
          </section>
        ) : null}

        <main className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto]
                         lg:grid-cols-[190px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)_auto]
                         xl:grid-cols-[210px_minmax(0,1fr)_300px] xl:grid-rows-1">
          <aside className="min-h-0 border-b border-border-subtle p-3 lg:border-b-0 lg:border-r">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-canvas-text-secondary">{t('分集')}</span>
              <span className="text-[10px] text-canvas-text-muted">{episodes.length}</span>
            </div>
            <div className="flex max-h-28 gap-1.5 overflow-auto lg:max-h-none lg:flex-col">
              {episodes.map((episode) => {
                const active = episode.id === currentEpisode?.id;
                return (
                  <button
                    key={episode.id}
                    type="button"
                    onClick={() => requestEpisodeSwitch(episode.id)}
                    className={`min-w-32 rounded-lg border px-2.5 py-2 text-left transition-colors lg:min-w-0 ${
                      active
                        ? 'border-indigo-400/40 bg-indigo-500/10'
                        : 'border-transparent hover:border-canvas-border hover:bg-canvas-hover'
                    }`}
                  >
                    <span className="block truncate text-[11px] font-medium text-canvas-text">{episode.name}</span>
                    <span className="mt-1 block truncate text-[10px] text-canvas-text-muted">
                      {episode.episodeScript?.trim()
                        ? t('正文 {count} 字', { count: episode.episodeScript.length })
                        : episode.episodeOutline?.trim()
                          ? t('已有大纲')
                          : t('尚未创作')}
                    </span>
                  </button>
                );
              })}
              {episodes.length === 0 ? (
                <div className="rounded-lg border border-dashed border-canvas-border p-3 text-center text-[11px] text-canvas-text-muted">
                  {t('还没有分集，可以先生成拆分草案。')}
                </div>
              ) : null}
            </div>
          </aside>

          <section className="flex min-h-0 flex-col border-border-subtle xl:border-r">
            {currentEpisode ? (
              <>
                <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border-subtle px-3">
                  {([
                    ['outline', '本集大纲', 'lucide:list-tree'],
                    ['script', '本集剧本', 'lucide:scroll-text'],
                    ['creative', '创作要点', 'lucide:lightbulb'],
                  ] as const).map(([id, label, icon]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setActiveTab(id)}
                      className={`flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs transition-colors ${
                        activeTab === id
                          ? 'bg-indigo-500/15 text-indigo-300'
                          : 'text-canvas-text-muted hover:bg-canvas-hover hover:text-canvas-text-secondary'
                      }`}
                    >
                      <Icon icon={icon} className="h-3.5 w-3.5" />
                      {t(label)}
                    </button>
                  ))}
                </div>

                <div className="min-h-0 flex-1 overflow-auto">
                  {activeTab === 'outline' ? (
                    <textarea
                      value={draft.outline}
                      onChange={(event) => setTextDraft('outline', event.target.value)}
                      spellCheck={false}
                      placeholder={t('写下本集任务、核心冲突、主要情节点和结尾卡点…')}
                      className="h-full min-h-80 w-full resize-none bg-transparent p-4 text-[13px] leading-7
                                 text-canvas-text outline-none placeholder:text-canvas-text-muted"
                    />
                  ) : null}
                  {activeTab === 'script' ? (
                    <textarea
                      value={draft.script}
                      onChange={(event) => setTextDraft('script', event.target.value)}
                      spellCheck={false}
                      placeholder={t('按场号、场景、人物、动作和对白写本集完整正文…')}
                      className="h-full min-h-80 w-full resize-none bg-transparent p-4 font-mono text-[13px]
                                 leading-7 text-canvas-text outline-none placeholder:text-canvas-text-muted"
                    />
                  ) : null}
                  {activeTab === 'creative' ? (
                    <div className="grid gap-4 p-4 md:grid-cols-2">
                      <CreativeField
                        label={t('本集任务')}
                        value={draft.creative.task}
                        placeholder={t('这一集必须完成什么叙事推进？')}
                        onChange={(value) => setCreative('task', value)}
                        onAiAction={() => { void openFieldPolish('task', t('本集任务'), Boolean(draft.creative.task.trim())); }}
                        aiDisabled={isSaving || projectLoadStatus !== 'ready'}
                      />
                      <CreativeField
                        label={t('核心冲突')}
                        value={draft.creative.coreConflict}
                        placeholder={t('谁与谁争夺什么，失败代价是什么？')}
                        onChange={(value) => setCreative('coreConflict', value)}
                        onAiAction={() => { void openFieldPolish('coreConflict', t('核心冲突'), Boolean(draft.creative.coreConflict.trim())); }}
                        aiDisabled={isSaving || projectLoadStatus !== 'ready'}
                      />
                      <CreativeField
                        label={t('开场钩子')}
                        value={draft.creative.openingHook}
                        placeholder={t('开场 3-5 秒发生什么？')}
                        onChange={(value) => setCreative('openingHook', value)}
                        onAiAction={() => { void openFieldPolish('openingHook', t('开场钩子'), Boolean(draft.creative.openingHook.trim())); }}
                        aiDisabled={isSaving || projectLoadStatus !== 'ready'}
                      />
                      <CreativeField
                        label={t('反转或情绪爆点')}
                        value={draft.creative.reversal}
                        placeholder={t('本集最强的变化是什么？')}
                        onChange={(value) => setCreative('reversal', value)}
                        onAiAction={() => { void openFieldPolish('reversal', t('反转或情绪爆点'), Boolean(draft.creative.reversal.trim())); }}
                        aiDisabled={isSaving || projectLoadStatus !== 'ready'}
                      />
                      <CreativeField
                        label={t('结尾卡点')}
                        value={draft.creative.endingHook}
                        placeholder={t('观众必须继续看的未完成事件')}
                        onChange={(value) => setCreative('endingHook', value)}
                        onAiAction={() => { void openFieldPolish('endingHook', t('结尾卡点'), Boolean(draft.creative.endingHook.trim())); }}
                        aiDisabled={isSaving || projectLoadStatus !== 'ready'}
                      />
                      <CreativeField
                        label={t('原著来源范围')}
                        value={draft.creative.sourceRange}
                        placeholder={t('例如：第 3 章 20%-45%')}
                        onChange={(value) => setCreative('sourceRange', value)}
                      />
                      <CreativeField
                        label={t('主要情节点（每行一条）')}
                        value={draft.creative.beats}
                        placeholder={t('建议 3-5 条，按发生顺序排列')}
                        multiline
                        onChange={(value) => setCreative('beats', value)}
                        onAiAction={() => { void openFieldPolish('beats', t('主要情节点（每行一条）'), Boolean(draft.creative.beats.trim())); }}
                        aiDisabled={isSaving || projectLoadStatus !== 'ready'}
                      />
                      <CreativeField
                        label={t('目标时长（秒）')}
                        value={draft.creative.targetDurationSec}
                        placeholder="90"
                        onChange={(value) => setCreative('targetDurationSec', value)}
                      />
                    </div>
                  ) : null}
                </div>

                <footer className="flex h-12 shrink-0 items-center gap-3 border-t border-border-subtle px-3">
                  <span className={`text-[11px] ${isDirty ? 'text-amber-300' : 'text-canvas-text-muted'}`}>
                    {isDirty ? t('有未保存修改') : t('已保存')}
                  </span>
                  <span className="hidden text-[10px] text-canvas-text-muted sm:inline">Ctrl+S</span>
                  <button
                    type="button"
                    disabled={!isDirty || isSaving || projectLoadStatus !== 'ready'}
                    onClick={() => { void saveDraft(); }}
                    className="ml-auto h-8 rounded-lg bg-indigo-500/90 px-4 text-xs font-medium text-white
                               hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isSaving ? t('保存中…') : t('保存本集')}
                  </button>
                </footer>
              </>
            ) : (
              <div className="grid min-h-80 flex-1 place-items-center p-6 text-center">
                <div>
                  <Icon icon="lucide:files" className="mx-auto h-8 w-8 text-canvas-text-muted" />
                  <p className="mt-3 text-sm font-medium">{t('还没有可编辑的分集')}</p>
                  <p className="mt-1 text-xs text-canvas-text-muted">{t('先新增分集，或使用 AI 拆分草案。')}</p>
                </div>
              </div>
            )}
          </section>

          <aside className="min-h-0 overflow-auto border-t border-border-subtle p-3
                            lg:col-span-2 lg:max-h-64 xl:col-span-1 xl:max-h-none xl:border-t-0">
            <div className="flex items-center gap-2">
              <Icon icon="lucide:scan-search" className="h-4 w-4 text-indigo-400" />
              <h3 className="text-[11px] font-semibold text-canvas-text-secondary">{t('创作诊断')}</h3>
              <span className="ml-auto text-[9px] text-canvas-text-muted">{t('仅提示，不阻断')}</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <MetricCard label={t('正文')} value={t('{count} 字', { count: analysis.metrics.characterCount })} />
              <MetricCard label={t('场景')} value={String(analysis.metrics.sceneCount)} />
              <MetricCard
                label={t('对白占比')}
                value={analysis.metrics.dialogueRatio === null
                  ? '—'
                  : `${Math.round(analysis.metrics.dialogueRatio * 100)}%`}
              />
              <MetricCard
                label={t('预计时长')}
                value={analysis.metrics.estimatedDurationSec === null
                  ? '—'
                  : t('约 {count} 秒', { count: analysis.metrics.estimatedDurationSec })}
              />
            </div>
            <div className="mt-2 grid gap-1.5">
              {analysis.diagnostics.slice(0, 4).map((item) => (
                <div key={item.id} className="rounded-lg border border-canvas-border bg-canvas-card p-2.5">
                  <p className="text-[11px] font-medium text-canvas-text-secondary">{t(item.title)}</p>
                  <p className="mt-1 text-[10px] leading-4 text-canvas-text-muted">{t(item.detail)}</p>
                </div>
              ))}
              {analysis.diagnostics.length === 0 ? (
                <p className="rounded-lg border border-canvas-border bg-canvas-card p-2.5 text-[10px] text-canvas-text-muted">
                  {t('暂未发现明显的静态格式问题；人物动机、冲突强度等仍需创作判断。')}
                </p>
              ) : null}
            </div>

            <div className="mt-4 grid gap-3">
              {CREATIVE_ACTION_GROUPS.map((group) => (
                <section key={group.label}>
                  <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold text-canvas-text-secondary">
                    <Icon icon={group.icon} className="h-3.5 w-3.5" />
                    {t(group.label)}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {group.actions.map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        disabled={!currentEpisode || isSaving || projectLoadStatus !== 'ready'}
                        onClick={() => { void openCreativeAction(action.id); }}
                        className="rounded-lg border border-canvas-border bg-canvas-card px-2.5 py-1.5
                                   text-[10px] text-canvas-text-secondary transition-colors hover:border-indigo-400/40
                                   hover:bg-indigo-500/10 hover:text-indigo-200 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {t(action.label)}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </aside>
        </main>
      </div>
    </ModalOverlay>
  );
}
