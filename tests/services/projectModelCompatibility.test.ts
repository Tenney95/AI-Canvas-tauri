/** 旧项目只读投影的兼容材料；本阶段只编写，不执行迁移或模型调用。 */
import { describe, expect, it } from 'vitest';
import { projectLegacyRecords, readLegacyProjectAggregate, resolveLegacyProjectFolder } from '../../src/services/projectModelCompatibility';
import type { LegacyProjectRecord } from '../../src/types/projectMigration';

const row = (id: string, values: Partial<LegacyProjectRecord> = {}): LegacyProjectRecord => ({
  id, name: id, createdAt: 1, updatedAt: 2, nodes: [], edges: [], ...values,
});

describe('旧项目领域只读投影', () => {
  it('普通项目不制造分集，身份和空画布仍保留', () => {
    const result = projectLegacyRecords([row('default')]);
    expect(result.quarantinedRecordIds).toEqual([]);
    expect(result.projects[0]).toMatchObject({ access: 'legacy-readonly', project: { id: 'default', kind: 'standalone' },
      episodes: [], standaloneCanvas: { id: 'default', projectId: 'default', episodeId: null, nodes: [], edges: [] } });
    expect(result.projects[0].bindings.map((binding) => binding.namespace)).toEqual(['legacy-root', 'legacy-canvas']);
  });

  it.each([false, true])('无子集的旧画布即使有共享稿也保持普通项目（空画布：%s）', (emptyCanvas) => {
    const originalWork = { fileName: '原著.txt', relativePath: 'manuscripts/原著.txt', addedAt: 3 };
    const source = row('ordinary-shared', { series: { script: '全剧共享稿', originalWork },
      episodeScript: '顶层创作稿', episodeOutline: '顶层大纲',
      nodes: emptyCanvas ? [] : [{ id: 'node', data: { text: '原画布' } }],
      snapshot: '原预览' });
    const result = projectLegacyRecords([source]);
    expect(result.quarantinedRecordIds).toEqual([]);
    expect(result.projects[0]).toMatchObject({ project: { id: source.id, kind: 'standalone' }, episodes: [],
      content: { script: '全剧共享稿', originalWork, standaloneCreative: { script: '顶层创作稿', outline: '顶层大纲' } },
      standaloneCanvas: { id: source.id, projectId: source.id, episodeId: null, nodes: source.nodes },
      standalonePreview: { canvasId: source.id, snapshot: '原预览' } });
    expect(result.sourceRecords).toEqual([source]);
    expect(result.projects[0].bindings).toContainEqual(expect.objectContaining({ namespace: 'legacy-canvas', legacyId: source.id }));
  });

  it('无子集且只有共享稿的空画布无法证明是普通项目还是中断的旧容器', () => {
    const source = row('ambiguous', { series: { script: '保留的共享稿' }, snapshot: '保留的预览' });
    const result = projectLegacyRecords([source]);
    expect(result.projects).toEqual([]);
    expect(result.quarantinedRecordIds).toEqual(['ambiguous']);
    expect(result.sourceRecords).toEqual([source]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'ambiguous_childless_series', severity: 'blocking', recordIds: ['ambiguous'],
    }));
  });

  it('已导入的孤立旧分集保留文稿、TXT原引用、组合包及未知源字段', () => {
    const source = row('legacy-episode', { episodeOutline: '旧集纲', episodeScript: '\uFEFF第一行\r\n第二行',
      episodeScriptFile: { fileName: '旧集.txt', relativePath: 'imports/legacy/旧集.txt', digest: 'A'.repeat(64) },
      episodeCreative: { openingHook: '冲突开场', beats: ['发现证据'] },
      creationProfile: { id: 'pack', version: '1.0.0', sha256: 'b'.repeat(64) },
      legacyNote: { retained: true } });
    const result = projectLegacyRecords([source]);
    expect(result.projects[0].project.kind).toBe('standalone');
    expect(result.projects[0].content.standaloneCreative).toMatchObject({ outline: '旧集纲', script: source.episodeScript,
      scriptFile: { ...source.episodeScriptFile, digest: 'a'.repeat(64) },
      creative: source.episodeCreative, creationProfile: source.creationProfile });
    expect(result.sourceRecords[0].episodeScriptFile?.digest).toBe('A'.repeat(64));
    expect(result.sourceRecords[0].legacyNote).toEqual({ retained: true });
    expect(result.sourceRecords[0]).not.toBe(source);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'unknown_legacy_fields', severity: 'warning' }));
  });

  it('父目录缺失时保留子目录/子ID；TXT仍使用现有owner保存域', () => {
    const owner = row('S', { settings: { defaultModels: { image: 'provider/model' } } });
    const ownFolder = row('E', { parentId: 'S', episodeNo: 1, dataFolder: '旧集目录', episodeScript: '本集正文' });
    const fallback = row('E2', { parentId: 'S', episodeNo: 2 });
    const aggregate = projectLegacyRecords([owner, ownFolder, fallback]).projects[0];
    const folder = (rootRef: string) => aggregate.project.storageBindings.find((binding) => binding.rootRef === rootRef)?.folderName;
    expect(folder(aggregate.episodes[0].canvas.storageRootRef)).toBe('旧集目录');
    expect(folder(aggregate.episodes[1].canvas.storageRootRef)).toBe('E2');
    expect(folder(aggregate.episodes[0].content.storageRootRef)).toBe('S');
    expect(aggregate.episodes[0].episode.settingsPolicy).toEqual({ mode: 'legacy-pinned', snapshot: {} });
    expect(resolveLegacyProjectFolder(ownFolder, { ...owner, dataFolder: '共享目录' })).toBe('共享目录');
    expect(resolveLegacyProjectFolder({ ...ownFolder, dataFolder: '' }, owner)).toBe('E');
    expect(resolveLegacyProjectFolder(ownFolder, { ...owner, dataFolder: '   ' })).toBe('E');
    expect(resolveLegacyProjectFolder({ ...ownFolder, dataFolder: '  原目录  ' }, owner)).toBe('原目录');
  });

  it('有父目录的整剧不产生第零集，旧设置不会被父默认覆盖', () => {
    const owner = row('S', { dataFolder: '整部剧-123', series: { script: '全剧稿' },
      settings: { visualStyle: { styleId: 'anime' } } });
    const child = row('E', { parentId: 'S', episodeNo: 1, dataFolder: '过时子目录',
      settings: { visualStyle: { styleId: 'realistic' } }, nodes: [{ id: 'n1', data: { prompt: '原节点' } }] });
    const result = projectLegacyRecords([owner, child]);
    const aggregate = result.projects[0];
    expect(aggregate.project.kind).toBe('series');
    expect(aggregate.standaloneCanvas).toBeUndefined();
    expect(aggregate.content.script).toBe('全剧稿');
    expect(aggregate.project.storageBindings).toHaveLength(1);
    expect(aggregate.episodes[0].episode.settingsPolicy).toEqual({ mode: 'legacy-pinned', snapshot: child.settings });
    expect(readLegacyProjectAggregate([owner, child], 'E')?.project.id).toBe('S');
    (aggregate.episodes[0].canvas.nodes[0] as { data: { prompt: string } }).data.prompt = '仅改投影';
    expect(child.nodes).toEqual([{ id: 'n1', data: { prompt: '原节点' } }]);
  });

  it('重复集号保持输入次序与原显示号，不合并实体', () => {
    const result = projectLegacyRecords([row('S'), row('B', { parentId: 'S', episodeNo: 2 }),
      row('A', { parentId: 'S', episodeNo: 2 }), row('C', { parentId: 'S' })]);
    expect(result.projects[0].episodes.map(({ episode }) => [episode.id, episode.displayNo, episode.orderRank]))
      .toEqual([['C', undefined, 0], ['B', 2, 1], ['A', 2, 2]]);
    expect(result.diagnostics.map((item) => item.code)).toContain('duplicate_episode_no');
  });

  it('坏画布隔离整部剧，不把缺失正文伪装成空画布', () => {
    const result = projectLegacyRecords([row('healthy'), row('S'), row('E', { parentId: 'S', nodes: undefined })]);
    expect(result.projects.map((item) => item.project.id)).toEqual(['healthy']);
    expect(result.quarantinedRecordIds).toEqual(['E', 'S']);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid_canvas', severity: 'blocking' }));
    expect(result.sourceRecords.find((item) => item.id === 'E')?.nodes).toBeUndefined();
    expect(readLegacyProjectAggregate(result.sourceRecords, 'E')).toBeNull();
  });

  it('坏父链、非空owner、重复身份和不安全目录都保留来源并阻止激活', () => {
    const inputs = [
      [row('orphan', { parentId: 'missing' })],
      [row('A', { parentId: 'B' }), row('B', { parentId: 'A' })],
      [row('S', { nodes: [{ id: 'original' }] }), row('E', { parentId: 'S' })],
      [row('S', { episodeScript: '无法猜所属集的旧文稿' }), row('E', { parentId: 'S' })],
      [row('S'), row('S')],
      [row('unsafe', { dataFolder: '../outside' })],
      [row('known-invalid', { episodeScriptFile: { fileName: '稿.txt', relativePath: '../稿.txt' } })],
    ];
    for (const records of inputs) {
      const result = projectLegacyRecords(records);
      expect(result.projects).toEqual([]);
      expect(result.sourceRecords).toEqual(records);
      expect(result.diagnostics.some((item) => item.severity === 'blocking')).toBe(true);
    }
  });

  it('重跑相同源产生相同映射，不提升epoch或新发ID', () => {
    const records = [row('S', { exchangeEpoch: 4 }), row('E', { parentId: 'S', exchangeEpoch: 7, episodeNo: 1 })];
    expect(projectLegacyRecords(records)).toEqual(projectLegacyRecords(records));
    expect(projectLegacyRecords(records).projects[0].episodes[0].canvas.epoch).toBe(7);
    expect(records).toEqual([row('S', { exchangeEpoch: 4 }), row('E', { parentId: 'S', exchangeEpoch: 7, episodeNo: 1 })]);
  });
});
