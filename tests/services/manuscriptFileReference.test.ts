/** TXT 稿件引用的可移植字段、文件名与同步判断。 */
import { describe, expect, it } from 'vitest';
import { buildEpisodeScriptFileName, needsEpisodeScriptFileSync, normalizeProjectTextFileReference } from '../../src/utils/manuscriptFileReference';
import { toProjectSummaryRecord } from '../../src/services/indexedDb/projectSummary';

describe('项目 TXT 稿件引用', () => {
  it('只保留白名单字段，文件名来自实际路径，归档 imports 引用仍可读取', () => {
    expect(normalizeProjectTextFileReference({ fileName: '旧名称.txt', relativePath: 'imports\\operation\\file-a\\新名称.txt',
      digest: 'A'.repeat(64), sourceName: '第一集.txt', filePath: 'C:/private/secret.txt', token: 'fixture-private' }))
      .toEqual({ fileName: '新名称.txt', relativePath: 'imports/operation/file-a/新名称.txt', digest: 'a'.repeat(64), sourceName: '第一集.txt' });
  });

  it.each(['C:/private/剧本.txt', '/private/剧本.txt', '\\\\server\\share\\剧本.txt', '../剧本.txt', 'manuscripts/../剧本.txt',
    'manuscripts//剧本.txt', 'manuscripts/剧本.md', 'manuscripts/坏\0名称.txt', 'manuscripts/CON.txt', 'manuscripts/剧本.txt '])('拒绝不可移植或非 TXT 的引用：%s', (relativePath) => {
    expect(normalizeProjectTextFileReference({ fileName: '剧本.txt', relativePath })).toBeUndefined();
  });

  it('摘要只保留安全引用，拒绝无效摘要或源文件名，不携带额外字段', () => {
    const episodeScriptFile = { fileName: '旧名称.txt', relativePath: 'manuscripts/第一集_1.txt',
      digest: 'a'.repeat(64), sourceName: '第一集.txt', filePath: '/private/secret.txt', token: 'fixture-private' };
    const record = { id: 'episode', name: '第一集', createdAt: 1, updatedAt: 2, parentId: 'series',
      episodeScript: '正式正文', episodeScriptFile, nodes: [{ content: '不应复制到摘要' }], edges: [] };
    const summary = toProjectSummaryRecord(record);
    expect(summary?.episodeScriptFile).toEqual({ fileName: '第一集_1.txt', relativePath: 'manuscripts/第一集_1.txt',
      digest: 'a'.repeat(64), sourceName: '第一集.txt' });
    expect(summary).not.toHaveProperty('nodes');
    expect(JSON.stringify(summary)).not.toContain('fixture-private');
    expect(toProjectSummaryRecord({ ...record, episodeScriptFile: { ...episodeScriptFile, digest: 'invalid' } }))
      .not.toHaveProperty('episodeScriptFile');
    expect(normalizeProjectTextFileReference({ ...episodeScriptFile, sourceName: '../第一集.txt' })).toBeUndefined();
  });

  it('名称清洗固定跨平台，唯一后缀不反复触发同步，改名或导入后需要同步', () => {
    expect(buildEpisodeScriptFileName('  第一/集:夜?  ')).toBe('第一_集_夜_.txt');
    expect(buildEpisodeScriptFileName('CON')).toBe('_CON.txt');
    expect(buildEpisodeScriptFileName('第一集.txt')).toBe('第一集.txt');
    expect(buildEpisodeScriptFileName('第一集：回家')).toBe('第一集：回家.txt');
    const episodeScriptFile = { fileName: '第一集_1.txt', relativePath: 'manuscripts/第一集_1.txt', sourceName: '第一集.txt' };
    expect(needsEpisodeScriptFileSync({ name: '第一集', episodeScriptFile })).toBe(false);
    expect(needsEpisodeScriptFileSync({ name: '第二集', episodeScriptFile })).toBe(true);
    expect(needsEpisodeScriptFileSync({ name: '第一集' })).toBe(true);
    expect(needsEpisodeScriptFileSync({ name: '第一集', episodeScriptFile: { ...episodeScriptFile,
      relativePath: 'imports/op/第一集_1.txt' } })).toBe(true);
  });

  it('长集名截断在空格或句点处时，生成的文件引用仍能保存并复用', () => {
    for (const separator of [' ', '.']) {
      const name = `${'长'.repeat(59)}${separator}尾声`;
      const fileName = buildEpisodeScriptFileName(name);
      const episodeScriptFile = { fileName, relativePath: `manuscripts/${fileName}`, sourceName: fileName };
      expect(fileName).toBe(`${'长'.repeat(59)}.txt`);
      expect(normalizeProjectTextFileReference(episodeScriptFile)).toEqual(episodeScriptFile);
      expect(needsEpisodeScriptFileSync({ name, episodeScriptFile })).toBe(false);
    }
  });
});
