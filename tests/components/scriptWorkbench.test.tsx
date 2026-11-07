import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ScriptWorkbenchView } from '../../src/components/ScriptWorkbench';
import type { ScriptWorkbenchSnapshot } from '../../src/types/scriptWorkbench';
import { analyzeEpisodeScript } from '../../src/services/seriesCreativeService';
import { createDefaultTeamProfile } from '../../src/services/chat/teams/teamProfileService';
import { createAppearanceUiSnapshot } from '../../src/services/appearance/appearanceWindowSync';
import { getBuiltinAppearanceTheme } from '../../src/services/appearance/appearanceDefaults';

vi.mock('../../src/components/shared/ModalOverlay', () => ({
  default: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) => isOpen ? <div>{children}</div> : null,
}));

function snapshot(): ScriptWorkbenchSnapshot {
  return { sessionId: 'workbench-session', revision: 1, acceptedEditSequence: 0, draftVersion: 0,
    series: { id: 'series', name: '剧集', hasScript: true, hasOriginal: false },
    episodes: [{ id: 'episode-a', name: '画布当前集', scriptLength: 2, hasOutline: true },
      { id: 'episode-b', name: '工作台选中集', scriptLength: 4, hasOutline: true }],
    currentEpisode: { id: 'episode-b', parentId: 'series', name: '工作台选中集', episodeOutline: '选中集大纲', episodeScript: '选中集正文' },
    canvasProjectId: 'episode-a', activeTab: 'outline', draft: { outline: '选中集大纲', script: '选中集正文',
      creative: { task: '', coreConflict: '', openingHook: '', reversal: '', endingHook: '', beats: '', targetDurationSec: '90', sourceRange: '' } },
    analysis: analyzeEpisodeScript('选中集正文', undefined), isDirty: false, isSaving: false, isStartingTeam: false,
    contextReady: true, editorWriteLocked: false, unsettledEditor: false, pendingAction: null,
    splitOpen: false, splitSource: 'script', targetEpisodeCount: '24', targetDurationSec: '90', sourceOpen: false,
    renamingEpisodeId: null, extractingAssetKind: null, seriesAssetPreview: null, existingAssets: [],
    executionSelection: { kind: 'single' }, teamMode: 'collaborative', teamProfile: createDefaultTeamProfile(),
    modelGroups: [], episodeTeamTasks: [], appearance: createAppearanceUiSnapshot(getBuiltinAppearanceTheme('standard-dark')),
    detached: false, openingWindow: false,
  };
}

function shotlistButton(html: string): string | undefined {
  return html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((button) => button.includes('生成本集分镜'));
}

describe('剧本工作台共享视图', () => {
  it('切换大纲和剧本时显示对应工具，只有剧本展示正文格式诊断', () => {
    const state = snapshot();
    const dispatch = vi.fn(async () => undefined);
    const outline = renderToStaticMarkup(<ScriptWorkbenchView snapshot={state} dispatch={dispatch} />);
    expect(outline).toContain('大纲助手');
    expect(outline).toContain('优化本集大纲');
    expect(outline).not.toContain('重写本集剧本');
    expect(outline).not.toContain('没有识别到标准场号');
    const script = renderToStaticMarkup(<ScriptWorkbenchView snapshot={{ ...state, activeTab: 'script' }} dispatch={dispatch} />);
    expect(script).toContain('剧本诊断');
    expect(script).toContain('重写本集剧本');
    expect(script).not.toContain('优化本集大纲');
    expect(script).toContain('没有识别到标准场号');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('原文只发布写作状态，隐藏本集执行配置与正文诊断', () => {
    const state: ScriptWorkbenchSnapshot = { ...snapshot(), activeTab: 'original',
      originalWriting: { loaded: false, loading: false, dirty: false, saving: false, generating: false,
        revision: 0, acceptedSequence: 0, characterCount: 0, chapterCount: 0, hasCandidate: false } };
    const dispatch = vi.fn(async () => undefined);
    const html = renderToStaticMarkup(<ScriptWorkbenchView snapshot={state} dispatch={dispatch} />);
    expect(html).toContain('原文写作');
    expect(html).not.toContain('创作执行方式');
    expect(html).not.toContain('全剧资产提取');
    expect(html).not.toContain('保存本集');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('展示本集智能调度状态、活动和查看入口，渲染不重新调用任务或切换画布', () => {
    const state: ScriptWorkbenchSnapshot = { ...snapshot(), episodeAgentTasks: [
      { id: 'agent-running', status: 'waiting_tool', title: '本集对白润色', activity: '加载 Skill：对白设计' },
      { id: 'agent-completed', status: 'completed', title: '本集结构诊断', activity: '结构诊断已完成' },
    ] };
    const dispatch = vi.fn(async () => undefined);
    const html = renderToStaticMarkup(<ScriptWorkbenchView standalone snapshot={state} dispatch={dispatch} />);
    const cards = html.match(/<section[^>]*aria-label="智能调度任务"[^>]*>[\s\S]*?<\/section>/g) ?? [];
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('本集对白润色');
    expect(cards[0]).toContain('执行中');
    expect(cards[0]).toContain('加载 Skill：对白设计');
    expect(cards[1]).toContain('本集结构诊断');
    expect(cards[1]).toContain('已完成');
    expect(cards.every((card) => card.includes('查看调用与结果'))).toBe(true);
    expect(state.canvasProjectId).toBe('episode-a');
    expect(state.currentEpisode?.id).toBe('episode-b');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('提供独立的故事关系图入口，普通页签渲染不读取图或调用模型', () => {
    const state = snapshot();
    const dispatch = vi.fn(async () => undefined);
    const html = renderToStaticMarkup(<ScriptWorkbenchView snapshot={state} dispatch={dispatch} />);
    expect(html).toContain('故事关系图');
    expect(state.canvasProjectId).toBe('episode-a');
    expect(state.currentEpisode?.id).toBe('episode-b');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('协作配置统一由顶部弹窗入口打开，初始渲染不展开组合包或改变执行方式', () => {
    const state = { ...snapshot(), creationProfiles: [{ id: 'writing', version: '1.0.0', name: '创作组合包示例' }] };
    const dispatch = vi.fn(async () => undefined);
    const html = renderToStaticMarkup(<ScriptWorkbenchView snapshot={state} dispatch={dispatch} />);
    const collaboration = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((button) => button.includes('Agent协作'));
    expect(collaboration).toContain('aria-haspopup="dialog"');
    expect(collaboration).toContain('aria-expanded="false"');
    expect(html).not.toContain('创作执行方式');
    expect(html).not.toContain('创作组合包示例');
    expect(state.executionSelection).toEqual({ kind: 'single' });
    expect(state.canvasProjectId).toBe('episode-a');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('显示工作台选中集的数据，非当前画布集不能直接生成分镜', () => {
    const state = snapshot();
    const dispatch = vi.fn(async () => undefined);
    const html = renderToStaticMarkup(<ScriptWorkbenchView snapshot={state} dispatch={dispatch} />);
    expect(html).toContain('选中集大纲');
    expect(html).toContain('工作台选中集');
    expect(shotlistButton(html)).toMatch(/^<button\b[^>]*\bdisabled=/);
    expect(state.canvasProjectId).toBe('episode-a');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('目标画布已由剧集栏激活后，允许原位置生成分镜', () => {
    const state = { ...snapshot(), canvasProjectId: 'episode-b' };
    const html = renderToStaticMarkup(<ScriptWorkbenchView standalone snapshot={state} dispatch={vi.fn(async () => undefined)} />);
    expect(shotlistButton(html)).toBeDefined();
    expect(shotlistButton(html)).not.toMatch(/^<button\b[^>]*\bdisabled=/);
    expect(html).toContain('收回主窗口');
  });

  it('画布离开原剧集时保留原稿，禁止保存旧上下文', () => {
    const state = { ...snapshot(), contextReady: false, isDirty: true };
    const html = renderToStaticMarkup(<ScriptWorkbenchView snapshot={state} dispatch={vi.fn(async () => undefined)} />);
    expect(html).toContain('选中集大纲');
    expect(html).toContain('画布已离开本剧集');
    expect(html).toMatch(/<textarea\b[^>]*\breadonly=/i);
    const save = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((button) => button.includes('保存本集'));
    expect(save).toMatch(/^<button\b[^>]*\bdisabled=/);
  });
});
