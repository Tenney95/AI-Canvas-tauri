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
  it('renders only safe creation profile options without applying them or switching canvas', () => {
    const state = { ...snapshot(), creationProfiles: [{ id: 'writing', version: '1.0.0', name: '创作组合包示例' }] };
    const dispatch = vi.fn(async () => undefined);
    const html = renderToStaticMarkup(<ScriptWorkbenchView snapshot={state} dispatch={dispatch} />);
    expect(html).toContain('创作组合包');
    expect(html).toContain('创作组合包示例');
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
