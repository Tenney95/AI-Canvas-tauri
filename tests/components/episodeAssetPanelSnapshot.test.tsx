import { describe, expect, it } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import type { DramaCharacter } from '../../src/types/dramaAssets';
import { buildEpisodeAssetPanelSnapshot } from '../../src/services/episodeAssetService';

const character: DramaCharacter = {
  id: 'character', kind: 'character', name: '林夏', key: '林夏', summary: '乘车人', visualNotes: '蓝色外套',
  identity: '乘客', importance: 'main', confirmed: true, source: 'manual', createdAt: 1, updatedAt: 1,
  imageNodeId: 'image-node', referenceImages: [{ id: 'portrait', kind: 'primary', prompt: '私有生成提示词',
    filePath: 'C:/private/portrait.png', imageUrl: 'https://example.test/saved-portrait.png', createdAt: 1, updatedAt: 1 }],
  voiceClips: [{ id: 'voice', kind: 'timbre', filePath: 'C:/private/voice.wav', transcript: '声音资料', createdAt: 1, updatedAt: 1 }],
};

function source() {
  const initial = useAppStore.getInitialState();
  return { ...initial, currentProjectId: 'episode-a', projectLoadStatus: 'ready' as const,
    projects: [{ id: 'series', name: '剧集', createdAt: 1, updatedAt: 1 },
      { id: 'episode-a', parentId: 'series', name: '第一集', createdAt: 1, updatedAt: 1 },
      { id: 'episode-b', parentId: 'series', name: '第二集', createdAt: 1, updatedAt: 1 }],
    dramaAssets: { version: 2 as const, characters: [character], scenes: [], props: [] },
    globalCharacters: [character],
    nodes: [{ id: 'image-node', position: { x: 1, y: 1 }, data: { type: 'ai-image' as const,
      label: '当前图图片', role: 'generator' as const, status: 'success' as const, imageUrl: 'https://example.test/current-canvas.png' } }],
  };
}

describe('工作台资产窗口快照', () => {
  it('非当前集不使用当前画布节点解释角色图，只发送展示字段', () => {
    const snapshot = buildEpisodeAssetPanelSnapshot(source(), 'episode-b');
    expect(snapshot.ready).toBe(true);
    expect(snapshot.nodes).toEqual([]);
    expect(snapshot.library.characters[0].imageUrl).toBe('https://example.test/saved-portrait.png');
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain('C:/private');
    expect(text).not.toContain('私有生成提示词');
    expect(text).not.toContain('voiceClips');
    expect(text).not.toContain('referenceImages');
    expect(text).not.toContain('current-canvas.png');
  });

  it('当前集只投影节点图片显示信息，不复制坐标或提示词', () => {
    const snapshot = buildEpisodeAssetPanelSnapshot(source(), 'episode-a');
    expect(snapshot.nodes).toEqual([{ id: 'image-node', data: { imageUrl: 'https://example.test/current-canvas.png', thumbnailUrl: undefined } }]);
    expect(snapshot.library.characters[0].imageUrl).toBe('https://example.test/current-canvas.png');
  });

  it('离开所属剧集或导航未就绪后不继续投影资产', () => {
    const snapshot = buildEpisodeAssetPanelSnapshot({ ...source(), projectLoadStatus: 'loading' }, 'episode-b');
    expect(snapshot).toMatchObject({ ready: false, episode: null, nodes: [], globalCharacters: [], globalProps: [],
      library: { characters: [], scenes: [], props: [] } });
  });
});
