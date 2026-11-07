/** P4 上下文合同回归源；本轮未执行。 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLegacyCanvasContext, captureLegacyEpisodeContext, captureLegacyProjectExpectedContext,
  isProjectExpectedContextCurrent, parseProjectExpectedContext } from '../../src/services/projectExecutionContext';
import type { ProjectExecutionContextState } from '../../src/types/projectExecutionContext';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());
const state = (): ProjectExecutionContextState => ({ currentProjectId: 'A', projects: [
  { id: 'S', exchangeEpoch: 2 }, { id: 'A', parentId: 'S', exchangeEpoch: 3 }, { id: 'B', parentId: 'S', exchangeEpoch: 4 },
], projectLoadStatus: 'ready', getCurrentRevision: () => 8 });

describe('P4 类型化执行前提', () => {
  it('跨连接原样可比；切集、同ID替换、进程代次变化均不能复用旧前提', () => {
    const current = state(), expected = captureLegacyCanvasContext(current)!;
    expect(expected).toMatchObject({ projectId: 'S', canvasId: 'A', episodeId: 'A', modelGeneration: 0 });
    expect(isProjectExpectedContextCurrent(structuredClone(expected), current)).toBe(true);
    expect(isProjectExpectedContextCurrent(expected, { ...current, currentProjectId: 'B' })).toBe(false);
    expect(isProjectExpectedContextCurrent(expected, { ...expected, canvasEpoch: 4 })).toBe(false);
    expect(isProjectExpectedContextCurrent(expected, { ...expected, projectEpoch: 3 })).toBe(false);
    expect(isProjectExpectedContextCurrent(expected, { ...expected, runtimeEpoch: 'another-process' })).toBe(false);
    expect(isProjectExpectedContextCurrent(expected, { ...expected, canvasRevision: 9 })).toBe(false);
    expect(isProjectExpectedContextCurrent(expected, { ...expected, canvasRevision: 9 }, { checkCanvasRevision: false })).toBe(true);
  });
  it('工作台可选择同owner的B正文，不把A画布revision当B正文条件', () => {
    const current = state(), selected = captureLegacyEpisodeContext(current, 'B')!;
    expect(selected).toMatchObject({ kind: 'episode', projectId: 'S', episodeId: 'B', episodeRevision: 4 });
    expect(isProjectExpectedContextCurrent(selected, current)).toBe(true);
    expect(captureLegacyEpisodeContext({ ...current, projects: [...current.projects!, { id: 'X' }, { id: 'Y', parentId: 'X' }] }, 'Y')).toBeNull();
    expect(isProjectExpectedContextCurrent({ ...selected, sourceHash: 'a'.repeat(64) }, current)).toBe(false);
  });
  it('启动页与零集剧集有不同scope；损坏关系和loading不制造画布', () => {
    expect(captureLegacyProjectExpectedContext({ ...state(), currentProjectId: null }).kind).toBe('global');
    const empty: ProjectExecutionContextState = { ...state(), currentProjectId: 'S', projects: [{ id: 'S', series: { script: '保留全剧资料' } }],
      projectExecutionContext: { kind: 'project', schemaVersion: 2, modelGeneration: 1, projectId: 'S', projectEpoch: 2 } };
    expect(captureLegacyCanvasContext(empty)).toBeNull();
    expect(captureLegacyProjectExpectedContext(empty)).toMatchObject({ kind: 'project', projectId: 'S' });
    expect(captureLegacyCanvasContext({ ...state(), projectLoadStatus: 'loading' })).toBeNull();
    expect(captureLegacyCanvasContext({ ...state(), isCreatingProject: true })).toBeNull();
    expect(captureLegacyCanvasContext({ ...state(), isReturningToStartPage: true })).toBeNull();
    expect(captureLegacyCanvasContext({ ...state(), projectExecutionContext: null })).toBeNull();
    expect(() => captureLegacyProjectExpectedContext({ ...state(), projectExecutionContext: null })).toThrow();
    expect(captureLegacyCanvasContext({ ...state(), projects: [{ id: 'A', parentId: 'missing' }] })).toBeNull();
  });
  it('旧普通画布添加原著/全剧稿仍保留原Canvas，真正存在子集的根仍是容器', () => {
    const current: ProjectExecutionContextState = { ...state(), currentProjectId: 'P',
      projects: [{ id: 'P', exchangeEpoch: 6, series: { originalWork: { fileName: '原著.txt' }, script: '全剧稿' } }] };
    const expected = captureLegacyCanvasContext(current)!;
    expect(expected).toMatchObject({ kind: 'canvas', projectId: 'P', canvasId: 'P', episodeId: null, canvasEpoch: 6 });
    expect(captureLegacyProjectExpectedContext(current)).toEqual(expected);
    expect(captureLegacyCanvasContext({ ...current, projects: [...current.projects!, { id: 'E', parentId: 'P' }] })).toBeNull();
  });
  it('拒绝未知字段、未来格式、访问器和控制字符，不执行getter或刷新旧意图', () => {
    const valid = captureLegacyCanvasContext(state())!;
    let calls = 0;
    const accessor = Object.defineProperty({}, 'kind', { get() { calls++; return 'canvas'; } });
    expect(() => parseProjectExpectedContext(accessor)).toThrow('上下文'); expect(calls).toBe(0);
    for (const input of [{ ...valid, schemaVersion: 3 }, { ...valid, extra: true }, { ...valid, projectId: ' S' },
      { ...valid, canvasId: 'A\u007f' }, { ...valid, canvasRevision: -1 }, { ...valid, runtimeEpoch: null }]) {
      expect(() => parseProjectExpectedContext(input)).toThrow();
    }
    expect(() => parseProjectExpectedContext(Object.defineProperty({ ...valid }, 'hidden', { value: true }))).toThrow();
    expect(() => parseProjectExpectedContext(Object.defineProperty({ ...valid }, 'kind', { value: 'canvas', enumerable: false }))).toThrow();
  });
});
