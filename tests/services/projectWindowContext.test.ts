import { describe, expect, it } from 'vitest';
import { captureProjectWindowContext, isProjectWindowContextCurrent, sameProjectWindowContext } from '../../src/services/projectWindowContext';
import type { ProjectExecutionContextState } from '../../src/types/projectExecutionContext';

function state(): ProjectExecutionContextState {
  return { currentProjectId: 'episode-a', projectLoadStatus: 'ready', switchingProjectName: null,
    projects: [{ id: 'series', exchangeEpoch: 3 }, { id: 'episode-a', parentId: 'series', exchangeEpoch: 4 },
      { id: 'episode-b', parentId: 'series', exchangeEpoch: 5 }, { id: 'foreign', parentId: 'other-series' }], getCurrentRevision: () => 7 };
}

describe('窗口项目与分集并发前提', () => {
  it('画布 A 与同剧工作台 B 各自绑定真实 ID，不把 B 改写为 A', () => {
    const current = state();
    const context = captureProjectWindowContext(current, 'episode-b');
    expect(context?.target).toMatchObject({ kind: 'episode', projectId: 'series', episodeId: 'episode-b', episodeRevision: 5 });
    expect(context?.canvas).toMatchObject({ canvasId: 'episode-a', episodeId: 'episode-a', canvasEpoch: 4 });
    expect(isProjectWindowContextCurrent(context, current)).toBe(true);
    expect(captureProjectWindowContext(current, 'foreign')).toBeNull();
    expect(captureProjectWindowContext(current, 'missing')).toBeNull();
  });

  it.each(['owner', 'canvas', 'episode', 'switch', 'restart'] as const)('拒绝 %s 变化后的旧窗口前提', (boundary) => {
    const current = state();
    const context = captureProjectWindowContext(current, 'episode-b')!;
    if (boundary === 'switch') current.currentProjectId = 'episode-b';
    else if (boundary === 'restart') context.target.runtimeEpoch = 'previous-process';
    else current.projects = current.projects!.map((project) => project.id === (boundary === 'owner' ? 'series' : boundary === 'canvas' ? 'episode-a' : 'episode-b')
      ? { ...project, exchangeEpoch: (project.exchangeEpoch ?? 0) + 1 } : project);
    expect(isProjectWindowContextCurrent(context, current)).toBe(false);
  });

  it('普通画布 revision 更新不重绑草稿；正文并发仍由原操作 guard 负责', () => {
    const current = state();
    const first = captureProjectWindowContext(current, 'episode-b');
    current.getCurrentRevision = () => 8;
    const next = captureProjectWindowContext(current, 'episode-b');
    expect(isProjectWindowContextCurrent(first, current)).toBe(true);
    expect(sameProjectWindowContext(first, next)).toBe(true);
    expect(sameProjectWindowContext(first, captureProjectWindowContext(current, 'episode-a'))).toBe(false);
    expect(sameProjectWindowContext(first, { ...first!, schemaVersion: 3 } as never)).toBe(false);
  });

  it('原生事件重排各层 JSON 键后仍识别同一租约，字段值变化仍拒绝', () => {
    const first = captureProjectWindowContext(state(), 'episode-b')!;
    const reordered = { canvas: Object.fromEntries(Object.entries(first.canvas!).reverse()),
      target: Object.fromEntries(Object.entries(first.target).reverse()), schemaVersion: 2 } as typeof first;
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(reordered));
    expect(sameProjectWindowContext(first, reordered)).toBe(true);
    expect(sameProjectWindowContext(first, { ...reordered, target: { ...first.target, runtimeEpoch: 'other-runtime' } })).toBe(false);
    expect(sameProjectWindowContext(first, { ...reordered, canvas: { ...first.canvas!, canvasEpoch: 100 } })).toBe(false);
  });
});
