import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import {
  readAgentPackageSourceText,
  removeAgentPackageSource,
  selectAgentPackageArchive,
  selectAgentPackageFolder,
} from '../../src/services/agentPackages/agentPackageImportService';

const preview = {
  sourceId: 'source-1',
  sourceType: 'folder' as const,
  name: '短剧助手',
  version: '1.0.0',
  manifest: { schemaVersion: 1 },
  entrypoints: ['AGENTS.md'],
  instructionText: 'instructions',
  skillCount: 28,
  fileCount: 534,
  totalBytes: 620_000_000,
  warnings: [],
  health: 'ready' as const,
  contentHash: 'hash-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue(preview);
});

describe('agentPackageImportService', () => {
  it('选择文件夹后只把路径交给原生命令并返回脱敏预览', async () => {
    mocks.open.mockResolvedValue('G:\\agents\\drama');

    await expect(selectAgentPackageFolder()).resolves.toEqual(preview);

    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({
      directory: true,
      multiple: false,
    }));
    expect(mocks.invoke).toHaveBeenCalledWith('agent_source_link', {
      sourcePath: 'G:\\agents\\drama',
    });
  });

  it('取消文件夹选择时返回 null 且不调用原生命令', async () => {
    mocks.open.mockResolvedValue(null);

    await expect(selectAgentPackageFolder()).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([
    'G:\\agents\\drama.aicanvas-agent',
    'G:\\agents\\drama.tgz',
    'G:\\agents\\drama.tar.gz',
  ])('导入受支持的压缩包 %s', async (archivePath) => {
    mocks.open.mockResolvedValue(archivePath);
    mocks.invoke.mockResolvedValue({ ...preview, sourceType: 'archive' });

    await expect(selectAgentPackageArchive()).resolves.toEqual({
      ...preview,
      sourceType: 'archive',
    });
    expect(mocks.invoke).toHaveBeenCalledWith('agent_package_import_archive', { archivePath });
  });

  it('拒绝不受支持的归档扩展且不调用原生命令', async () => {
    mocks.open.mockResolvedValue('G:\\agents\\drama.zip');

    await expect(selectAgentPackageArchive()).rejects.toThrow(
      '仅支持 .aicanvas-agent、.tgz 或 .tar.gz 智能体包',
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('取消压缩包选择时返回 null 且不调用原生命令', async () => {
    mocks.open.mockResolvedValue(null);

    await expect(selectAgentPackageArchive()).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('通过脱敏 sourceId 移除原生来源注册', async () => {
    const result = {
      sourceId: 'source-1',
      sourceType: 'archive',
      removed: true,
      externalSourcePreserved: false,
    };
    mocks.invoke.mockResolvedValue(result);

    await expect(removeAgentPackageSource('source-1')).resolves.toEqual(result);
    expect(mocks.invoke).toHaveBeenCalledWith('agent_source_remove', {
      sourceId: 'source-1',
    });
  });

  it('只把脱敏 sourceId、相对路径和本次字节上限交给原生文本读取', async () => {
    const result = {
      relativePath: 'skills/drama/SKILL.md',
      content: '# Drama Skill',
      sha256: 'a'.repeat(64),
    };
    mocks.invoke.mockResolvedValue(result);

    await expect(readAgentPackageSourceText(
      'source-1',
      'skills/drama/SKILL.md',
      131072,
    )).resolves.toEqual(result);
    expect(mocks.invoke).toHaveBeenCalledWith('agent_source_read_text', {
      sourceId: 'source-1',
      relativePath: 'skills/drama/SKILL.md',
      maxBytes: 131072,
    });
  });
});
