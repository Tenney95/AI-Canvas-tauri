import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';

const mocks = vi.hoisted(() => ({
  store: {
    nodes: [] as Array<{ id: string; data: BaseNodeData }>,
    currentProjectId: 'native-canvas',
    updateNodeData: vi.fn(),
  },
  getNativeProjectOwner: vi.fn(),
  getAssetUrlFromPath: vi.fn(),
  renameProjectFileToLabel: vi.fn(),
}));

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useCallback: <T>(callback: T) => callback,
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.store } }));
vi.mock('../../src/services/fileService', () => ({
  buildNodeFileName: vi.fn(),
  getAssetUrlFromPath: mocks.getAssetUrlFromPath,
  getNativeProjectOwner: mocks.getNativeProjectOwner,
  renameProjectFileToLabel: mocks.renameProjectFileToLabel,
}));

import { useNodeRename } from '../../src/components/nodes/shared/useNodeRename';

const digest = 'b'.repeat(64);

describe('原生媒体节点标题', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getNativeProjectOwner.mockReturnValue('native-project');
  });

  it.each([
    ['ai-image', 'imageUrl', `media/${digest}.png`],
    ['ai-video', 'videoUrl', `imports/retained-${digest}/${digest}.mp4`],
    ['ai-audio', 'audioUrl', `media/${digest}.wav`],
  ] as const)('%s 改名只更新标题并保留原文件名与身份', (type, mediaField, relativePath) => {
    const filePath = `/project/${relativePath}`;
    const node: BaseNodeData = {
      type, label: '原产物', fileName: relativePath.split('/').at(-1), filePath,
      relativePath, artifactId: 'native-media-12345678-1234-4123-8123-123456789abc',
      [mediaField]: `asset://${filePath}`,
    };
    mocks.store.nodes = [{ id: 'media', data: node }];

    useNodeRename('media', node, '').handleRename('新标题');

    expect(mocks.store.updateNodeData).toHaveBeenCalledExactlyOnceWith('media', { label: '新标题', displayLabel: '新标题' });
    expect(mocks.renameProjectFileToLabel).not.toHaveBeenCalled();
    expect(mocks.getAssetUrlFromPath).not.toHaveBeenCalled();
  });
});
