/** 项目协作协议：身份、完整材料、摘要与公共祖先边界。 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExchangeBundle, ProjectExchangeSnapshot } from '../../src/types/projectExchange';
import { createProjectExchangeRevision, findProjectExchangeBase, parseProjectExchangeBundle,
  parseProjectExchangeSnapshot, projectExchangeRevisionHeader, serializeProjectExchangeValue,
  verifyProjectExchangeRevision } from '../../src/services/projectExchangeFormat';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

function snapshot(prompt = '原始提示词', lineageId = 'lineage'): ProjectExchangeSnapshot {
  return { format: 'ai-canvas-project-snapshot', canonicalVersion: 1, lineageId, rootProjectId: 'root', complete: true,
    entities: [
      { kind: 'project', scopeId: 'root', id: 'root', data: { name: '中文项目' }, references: [] },
      { kind: 'node', scopeId: 'root', id: 'node', data: { prompt, position: { x: 1, y: 2 } },
        references: [{ kind: 'project', scopeId: 'root', id: 'root' }] },
    ], media: [] };
}
function parsingError(input: ProjectExchangeSnapshot): Error {
  try { parseProjectExchangeSnapshot(input); }
  catch (error) { if (error instanceof Error) return error; throw error; }
  throw new Error('预期协议校验拒绝此材料');
}
async function bundle(): Promise<ProjectExchangeBundle> {
  const revision = await createProjectExchangeRevision(snapshot());
  return { format: 'ai-canvas-project-exchange', version: 1, packageId: 'package', lineageId: 'lineage',
    headRevisionId: revision.revisionId, revisions: [revision], ancestors: [], files: [] };
}

describe('项目协作协议', () => {
  it('规范实体/对象顺序不改变摘要，正文、null和用户数组顺序仍是业务变化', async () => {
    const original = snapshot();
    const reordered = structuredClone(original); reordered.entities.reverse();
    const left = await createProjectExchangeRevision(original), right = await createProjectExchangeRevision(reordered);
    expect(left).toEqual(right);
    expect(serializeProjectExchangeValue({ b: 2, a: 1 })).toBe(serializeProjectExchangeValue({ a: 1, b: 2 }));
    expect((await createProjectExchangeRevision(snapshot('已修改'))).contentDigest).not.toBe(left.contentDigest);
    expect(serializeProjectExchangeValue({ a: null })).not.toBe(serializeProjectExchangeValue({}));
    expect(serializeProjectExchangeValue(['甲', '乙'])).not.toBe(serializeProjectExchangeValue(['乙', '甲']));
  });

  it('损坏、重复、不完整或带机器/凭据字段的材料失败关闭', () => {
    for (const mutate of [
      (value: ProjectExchangeSnapshot) => { value.complete = false as true; },
      (value: ProjectExchangeSnapshot) => { value.entities.push(value.entities[0]); },
      (value: ProjectExchangeSnapshot) => { value.entities[1].references[0].id = 'missing'; },
      (value: ProjectExchangeSnapshot) => { value.entities[1].data.filePath = 'C:/private/file.png'; },
      (value: ProjectExchangeSnapshot) => { value.entities[1].data.apiKey = 'do-not-persist'; },
      (value: ProjectExchangeSnapshot) => { value.entities[1].data.api_key = 'do-not-persist'; },
      (value: ProjectExchangeSnapshot) => { value.entities[1].data.position = { x: NaN, y: 1 }; },
      (value: ProjectExchangeSnapshot) => { value.entities[1].data = JSON.parse('{"__proto__":{"injected":true}}'); },
    ]) {
      const input = snapshot(); mutate(input);
      expect(() => parseProjectExchangeSnapshot(input)).toThrow('项目协作材料格式无效');
    }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => serializeProjectExchangeValue(cycle)).toThrow();
  });

  it('嵌套数组中的不可迁移字段报告完整结构路径和分类，不回显凭据值', () => {
    const value = snapshot('不应回显的完整正文');
    const secret = 'secret-value-never-include-in-diagnostics';
    value.entities[1].data.workflowInputs = [{ inputs: [{ value: { api_key: secret } }] }];
    const error = parsingError(value);
    expect(error.cause).toEqual({ code: 'non_portable_field', fieldPath: 'entities[1].data.workflowInputs[0].inputs[0].value.api_key' });
    expect(error.message).toContain('non_portable_field');
    expect(error.message).toContain('entities[1].data.workflowInputs[0].inputs[0].value.api_key');
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain('不应回显的完整正文');
  });

  it('短凭据形态的动态字段名也必须脱敏，不回显原键', () => {
    const value = snapshot();
    const dynamicKey = 'sk-proj-fixture-secret';
    value.entities[1].data.workflowInputs = { [dynamicKey]: NaN };
    const error = parsingError(value);
    expect(error.cause).toEqual({ code: 'invalid_format', fieldPath: 'entities[1].data.workflowInputs.[动态字段0]' });
    expect(error.message).toContain('[动态字段0]');
    expect(error.message + JSON.stringify(error.cause)).not.toContain(dynamicKey);
  });

  it('非法身份指向输入实体索引，不回显作为 ID 误传的本机路径', () => {
    const value = snapshot();
    const original = value.entities[1];
    const unsafeId = 'C:/private/project-secret/invalid-node';
    value.entities = [{ ...original, id: 'z-first' }, value.entities[0], { ...original, id: unsafeId }];
    const error = parsingError(value);
    expect(error.cause).toEqual({ code: 'invalid_identity', fieldPath: 'entities[2].id' });
    expect(error.message).toContain('invalid_identity');
    expect(error.message).toContain('entities[2].id');
    expect(JSON.stringify(error.cause) + error.message).not.toContain(unsafeId);
    expect(error.message).not.toContain('project-secret');
  });

  it('重复身份指向第二次出现的原始实体索引，不使用规范排序后的索引', () => {
    const value = snapshot();
    const original = value.entities[1];
    value.entities = [{ ...original, id: 'z-last' }, value.entities[0], { ...original, id: 'a-first' }, { ...original, id: 'z-last' }];
    const error = parsingError(value);
    expect(error.cause).toEqual({ code: 'duplicate_identity', fieldPath: 'entities[3].id' });
    expect(error.message).toContain('duplicate_identity');
    expect(error.message).toContain('entities[3].id');
  });

  it('缺失依赖报告安全的类型和 ID，以及原输入源实体的引用字段', () => {
    const value = snapshot();
    const dependency = { kind: 'node' as const, scopeId: 'root', id: 'missing-source' };
    value.entities.push({ ...value.entities[1], id: 'a-first', references: [dependency] });
    const error = parsingError(value);
    expect(error.cause).toEqual({ code: 'missing_dependency', fieldPath: 'entities[2].references', dependency });
    expect(error.message).toContain('missing_dependency');
    expect(error.message).toContain('entities[2].references');
    expect(error.message).toContain('缺失依赖：node（ID：missing-source）');
  });

  it('正式版本重新核对正文与父关系摘要，不能只相信传入的 revisionId', async () => {
    const revision = await createProjectExchangeRevision(snapshot());
    expect(await verifyProjectExchangeRevision(revision)).toEqual(revision);
    const altered = structuredClone(revision); altered.snapshot.entities[0].data.name = '篡改正文';
    await expect(verifyProjectExchangeRevision(altered)).rejects.toThrow();
    await expect(verifyProjectExchangeRevision({ ...revision, contentDigest: 'a'.repeat(64) })).rejects.toThrow();
    await expect(createProjectExchangeRevision(snapshot(), [revision.revisionId, revision.revisionId])).rejects.toThrow();
  });

  it('同字节的逻辑文件不合并身份，递归与媒体字节预算有明确边界', () => {
    const value = snapshot();
    for (const id of ['file-a', 'file-b']) {
      value.entities.push({ kind: 'file', scopeId: 'root', id, data: { mediaId: id }, references: [] });
      value.media.push({ id, kind: 'file', extension: 'txt', bytes: 0, sha256: 'a'.repeat(64) });
    }
    expect(parseProjectExchangeSnapshot(value).media).toHaveLength(2);
    value.media[0].bytes = 20 * 1024 * 1024 * 1024 + 1;
    expect(() => parseProjectExchangeSnapshot(value)).toThrow();
    let deep: unknown = '底层';
    for (let i = 0; i < 40; i++) deep = { child: deep };
    expect(() => serializeProjectExchangeValue(deep)).toThrow();
  });

  it('交换包只接受与当前快照完全对应的安全文件清单', async () => {
    const input = await bundle();
    expect(await parseProjectExchangeBundle(JSON.stringify(input))).toEqual(input);
    await expect(parseProjectExchangeBundle({ ...input, apiKey: 'do-not-persist' })).rejects.toThrow();
    const body = snapshot();
    body.entities.push({ kind: 'file', scopeId: 'root', id: 'file', references: [], data: { mediaId: 'media' } });
    body.media = [{ id: 'media', kind: 'image', extension: 'png', bytes: 10, sha256: 'a'.repeat(64) }];
    const revision = await createProjectExchangeRevision(body);
    const files = { ...input, revisions: [revision], headRevisionId: revision.revisionId,
      files: [{ mediaId: 'media', archivePath: 'assets/中文素材.png' }] };
    expect((await parseProjectExchangeBundle(files)).files).toEqual(files.files);
    for (const archivePath of ['../escape.png', 'assets/../escape.png', 'assets/C:/escape.png', 'assets/a\\b.png', 'assets/NUL.png']) {
      await expect(parseProjectExchangeBundle({ ...files, files: [{ mediaId: 'media', archivePath }] })).rejects.toThrow();
    }
    await expect(parseProjectExchangeBundle({ ...files, files: [] })).rejects.toThrow();
    await expect(parseProjectExchangeBundle({ ...files, files: [...files.files, ...files.files] })).rejects.toThrow();
  });

  it('连续往返选择唯一最近公共版本，不把当前一侧直接当成共同基线', async () => {
    const base = await createProjectExchangeRevision(snapshot());
    const mine = await createProjectExchangeRevision(snapshot('甲修改'), [base.revisionId]);
    const theirs = await createProjectExchangeRevision(snapshot('乙修改'), [base.revisionId]);
    const merged = await createProjectExchangeRevision(snapshot('甲选择保留本地'), [mine.revisionId, theirs.revisionId]);
    expect(await findProjectExchangeBase(mine.revisionId, theirs.revisionId, [base, mine, theirs]))
      .toEqual({ status: 'found', revision: base });
    expect(await findProjectExchangeBase(merged.revisionId, theirs.revisionId, [base, mine, theirs, merged]))
      .toEqual({ status: 'found', revision: theirs });
    const other = await createProjectExchangeRevision(snapshot('其他项目', 'other-lineage'));
    expect(await findProjectExchangeBase(base.revisionId, other.revisionId, [base, other])).toEqual({ status: 'unrelated' });
  });

  it('缺正文、缺父链和交叉合并多基线分别降级，不能按时间猜测', async () => {
    const base = await createProjectExchangeRevision(snapshot());
    const mine = await createProjectExchangeRevision(snapshot('甲'), [base.revisionId]);
    const theirs = await createProjectExchangeRevision(snapshot('乙'), [base.revisionId]);
    expect(await findProjectExchangeBase(mine.revisionId, theirs.revisionId, [mine, theirs])).toEqual({ status: 'incomplete' });
    expect(await findProjectExchangeBase(mine.revisionId, theirs.revisionId, [mine, theirs], [projectExchangeRevisionHeader(base)]))
      .toEqual({ status: 'missingSnapshot' });
    const mergedMine = await createProjectExchangeRevision(snapshot('合并甲'), [mine.revisionId, theirs.revisionId]);
    const mergedTheirs = await createProjectExchangeRevision(snapshot('合并乙'), [mine.revisionId, theirs.revisionId]);
    expect(await findProjectExchangeBase(mergedMine.revisionId, mergedTheirs.revisionId, [base, mine, theirs, mergedMine, mergedTheirs]))
      .toEqual({ status: 'ambiguous' });
  });
});
