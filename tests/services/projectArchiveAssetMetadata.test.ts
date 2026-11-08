import { describe, expect, it, vi } from 'vitest';
import { validateArchiveAssetMetadata } from '../../src/services/projectArchiveAssetMetadata';
import { buildProjectExchangeSnapshotV2, readProjectArchiveV4, serializeProjectArchiveV4 } from '../../src/services/projectArchiveV4';
import { createProjectExchangeRevisionV2 } from '../../src/services/projectExchangeV2Format';
import type { ProjectArchiveAssetMetadataV4, ProjectArchiveBusinessV4, ProjectArchivePayloadV4 } from '../../src/types/projectArchiveV4';

vi.mock('../../src/services/projectArchiveSerialization', () => ({ serializeProjectArchiveEntries:
  async (rows: Array<{ path: string; value: unknown }>) => rows.map((row) => ({ path: row.path, content: JSON.stringify(row.value) })) }));
const files = [{ id: 'file', rootRef: 'root', relativePath: 'a.png', mediaId: 'media' }];
const metadata = (): ProjectArchiveAssetMetadataV4 => ({ version: 1, records: [{ fileId: 'file',
  tags: { tags: ['角色'], taggedBy: 'manual', updatedAt: 1 }, images: [{ contentDigest: 'a'.repeat(64), fileName: 'a.png',
    prompt: '原图片提示词', references: [], revision: 1, updatedAt: 1 }] }] });

describe('可移植素材元数据', () => {
  it('拒绝本机身份/路径、未知文件、重复身份和缺失参考图闭包', () => {
    expect(() => validateArchiveAssetMetadata(metadata(), files)).not.toThrow();
    expect(() => validateArchiveAssetMetadata(metadata(), [])).toThrow();
    expect(() => validateArchiveAssetMetadata({ ...metadata(), path: 'C:/private' }, files)).toThrow();
    expect(() => validateArchiveAssetMetadata({ version: 1, records: [...metadata().records, ...metadata().records] }, files)).toThrow();
    const unsafe = metadata();
    Object.assign(unsafe.records[0].images![0], { references: [{ id: 'ref', name: 'missing', fileId: 'missing', digest: 'b'.repeat(64), bytes: 1 }] });
    expect(() => validateArchiveAssetMetadata(unsafe, files)).toThrow('闭包');
    unsafe.records[0].images![0].references = [{ id: 'ref', name: 'reference', fileId: 'file', digest: 'a'.repeat(64), bytes: 3 }];
    expect(() => validateArchiveAssetMetadata(unsafe, files, [{ id: 'media', kind: 'image', extension: 'png', bytes: 3, sha256: 'a'.repeat(64) }])).not.toThrow();
  });
  it('附件由manifest摘要覆盖，往返保留标签和图片提示词', async () => {
    const business: ProjectArchiveBusinessV4 = { project: { id: 'project', name: '素材归档', kind: 'series', storageRoots: [{ id: 'root', role: 'shared' }] },
      episodes: [], canvases: [], contents: { project: { projectId: 'project', data: {} }, episodes: [] } };
    const snapshot = buildProjectExchangeSnapshotV2(business, 'lineage', [{ id: 'media', kind: 'image', extension: 'png', bytes: 3, sha256: 'a'.repeat(64) }], files);
    const revision = await createProjectExchangeRevisionV2(snapshot);
    const input: ProjectArchivePayloadV4 = { ...business, assetMetadata: metadata(), exchange: { format: 'ai-canvas-project-exchange', version: 2,
      packageId: 'package', lineageId: 'lineage', head: { canonicalVersion: 2, revisionId: revision.revisionId }, revisions: [revision], ancestors: [],
      files: [{ mediaId: 'media', archivePath: 'assets/a.png' }] } };
    const assets = [{ path: 'a.png', bytes: 3, sha256: 'a'.repeat(64) }];
    const entries = await serializeProjectArchiveV4(input, { packageId: 'package', exportedAt: 1 }, assets);
    const texts = Object.fromEntries(entries.map((row) => [row.path, row.content]));
    const parsed = await readProjectArchiveV4(texts, assets);
    expect(parsed.payload.assetMetadata).toEqual(input.assetMetadata);
    await expect(readProjectArchiveV4({ ...texts, 'asset-metadata.json': '{}' }, assets)).rejects.toThrow('摘要');
  });
});
