/** 角色动作媒体转换回归：媒体类型、来源身份和缺失素材边界。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actionMediaFromCanvasNode } from '../../src/components/character/characterActionMedia';
import { generateId } from '../../src/store/store.utils';
import type { BaseNodeData } from '../../src/types';

vi.mock('../../src/store/store.utils', () => ({ generateId: vi.fn(() => 'media-id') }));

const node = (data: Partial<BaseNodeData> = {}): { data: BaseNodeData } => ({
  data: { label: '动作节点', type: 'ai-image', ...data },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(1234);
});
afterEach(() => vi.restoreAllMocks());

describe('画布节点转角色动作素材', () => {
  it('没有节点或媒体时返回空值，不分配素材 ID', () => {
    expect(actionMediaFromCanvasNode()).toBeNull();
    expect(Date.now).not.toHaveBeenCalled();
    expect(actionMediaFromCanvasNode(node())).toBeNull();
    expect(Date.now).not.toHaveBeenCalled();
    expect(generateId).not.toHaveBeenCalled();
  });

  it.each([
    [{ fileName: 'clip.WEBM?download=1', filePath: 'clip.mov' }, 'video/webm'],
    [{ filePath: 'clip.mov#preview' }, 'video/quicktime'],
    [{ fileName: 'clip.m4v' }, 'video/x-m4v'],
    [{ videoUrl: 'https://media.test/clip.WEBM?download=1' }, 'video/webm'],
    [{}, 'video/mp4'],
    [{ fileName: 'clip.unknown' }, 'video/mp4'],
  ] as const)('视频优先于图片，按文件名、路径、URL顺序识别 MIME：%j', (data, mimeType) => {
    const source = node({ videoUrl: 'https://media.test/clip.mp4?token=value', imageUrl: 'image.png', ...data });
    expect(actionMediaFromCanvasNode(source)).toMatchObject({ kind: 'video', mimeType, url: source.data.videoUrl });
  });

  it.each([
    [{ fileName: 'portrait.jpeg#preview', imageUrl: 'image' }, 'image', 'image/jpeg'],
    [{ filePath: 'portrait.webp?preview=1', imageUrl: 'image' }, 'image', 'image/webp'],
    [{ fileName: 'portrait.avif', imageUrl: 'image' }, 'image', 'image/avif'],
    [{ imageUrl: 'image.unknown' }, 'image', 'image/png'],
    [{ imageUrl: 'clip.GIF?preview=1' }, 'gif', 'image/gif'],
    [{ filePath: 'clip.gif?preview=1', imageUrl: 'image' }, 'gif', 'image/gif'],
    [{ imageUrl: 'data:image/gif;base64,eA==' }, 'gif', 'image/gif'],
    [{ fileName: 'portrait.png', imageUrl: 'data:IMAGE/WEBP;base64,eA==' }, 'image', 'image/webp'],
  ] as const)('保留图片、GIF 和 data URL 的 MIME 推断：%j', (data, kind, mimeType) => {
    expect(actionMediaFromCanvasNode(node(data))).toMatchObject({ kind, mimeType, url: data.imageUrl });
  });

  it('原样保留媒体身份、文件名和地址，一次取时且仅分配一次 ID', () => {
    const source = node({ fileName: '动作.png', assetId: 'asset', relativePath: 'images/action.png',
      filePath: 'project/images/action.png', imageUrl: 'image.png', thumbnailUrl: 'thumb.png' });
    const original = { ...source.data };
    const media = actionMediaFromCanvasNode(source);
    expect(media).toEqual({ id: 'action-media-media-id', kind: 'image', name: '动作.png', mimeType: 'image/png',
      assetId: 'asset', relativePath: 'images/action.png', filePath: 'project/images/action.png', url: 'image.png',
      createdAt: 1234, updatedAt: 1234 });
    expect(generateId).toHaveBeenCalledTimes(1);
    expect(Date.now).toHaveBeenCalledTimes(1);
    expect(source.data).toEqual(original);
  });

  it('缺少主图时使用缩略图，名称依次回退到节点标题和默认值', () => {
    expect(actionMediaFromCanvasNode(node({ thumbnailUrl: 'thumb.png' })))
      .toMatchObject({ name: '动作节点', url: 'thumb.png' });
    expect(actionMediaFromCanvasNode(node({ label: '', thumbnailUrl: 'thumb.png' })))
      .toMatchObject({ name: '画布动作素材', url: 'thumb.png' });
  });
});
