/**
 * connectedNodesPreviewInteractions — 回归测试：ConnectedNodesPreview 交互。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateDockOffset,
  calculateReferenceFan,
  CONNECTED_PREVIEW_GAP,
  CONNECTED_PREVIEW_THUMB_SIZE,
  REFERENCE_FAN_THUMB_SIZE,
  createConnectedPreviewLongPressController,
  createConnectedPreviewSelector,
  getConnectedPreviewEdgeIds,
  resolveMentionPreview,
} from '../../src/components/nodes/shared/connectedNodesPreviewInteractions';
import type { BaseNodeData } from '../../src/types';

describe('ConnectedNodesPreview 交互', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('有足够空间时沿装饰圆弧展开，卡片方向随位置朝向圆心', () => {
    const arcCenter = { x: 12, y: 12 };
    const layout = calculateReferenceFan({ x: 400, y: 400 }, { width: 1200, height: 800 }, 3, arcCenter);
    expect(layout.inward).toBe(false);
    const radii = layout.items.map((item) => Math.hypot(item.x - arcCenter.x, item.y - arcCenter.y));
    for (const radius of radii) {
      expect(radius).toBeCloseTo(radii[0]);
      expect(radius).toBeLessThan(100);
    }
    expect(layout.items[0].x).toBeCloseTo(arcCenter.x);
    expect(layout.items[0].y).toBeLessThan(arcCenter.y);
    expect(layout.items[1].x).toBeLessThan(arcCenter.x);
    expect(layout.items[1].y).toBeLessThan(arcCenter.y);
    expect(layout.items[2].x).toBeLessThan(arcCenter.x);
    expect(layout.items[2].y).toBeCloseTo(arcCenter.y);
    expect(layout.items.map((item) => item.rotate)).toEqual([0, -45, -90]);
    for (const item of layout.items) {
      const rotation = item.rotate * Math.PI / 180;
      const toCenter = { x: arcCenter.x - item.x, y: arcCenter.y - item.y };
      const radius = Math.hypot(toCenter.x, toCenter.y);
      expect(-Math.sin(rotation)).toBeCloseTo(toCenter.x / radius);
      expect(Math.cos(rotation)).toBeCloseTo(toCenter.y / radius);
    }
    for (let index = 1; index < layout.items.length; index++) {
      expect(Math.hypot(layout.items[index - 1].x - layout.items[index].x, layout.items[index - 1].y - layout.items[index].y)).toBeGreaterThan(64);
    }
  });

  it.each([[16, 16], [304, 16], [16, 464], [304, 464]].flatMap(([x, y]) => [3, 20].map((count) => [x, y, count])))('靠近视口边缘 (%s, %s) 时 %s 张旋转后的素材仍在屏幕内', (x, y, count) => {
    const layout = calculateReferenceFan({ x, y }, { width: 320, height: 480 }, count, { x: 12, y: 12 });
    expect(layout.items).toHaveLength(count);
    for (const item of layout.items) {
      const rotation = item.rotate * Math.PI / 180;
      for (const horizontal of [-1, 1]) {
        for (const vertical of [-1, 1]) {
          const cornerX = x + item.x + REFERENCE_FAN_THUMB_SIZE / 2 * (horizontal * Math.cos(rotation) - vertical * Math.sin(rotation));
          const cornerY = y + item.y + REFERENCE_FAN_THUMB_SIZE / 2 * (horizontal * Math.sin(rotation) + vertical * Math.cos(rotation));
          expect(cornerX).toBeGreaterThanOrEqual(12);
          expect(cornerX).toBeLessThanOrEqual(308);
          expect(cornerY).toBeGreaterThanOrEqual(12);
          expect(cornerY).toBeLessThanOrEqual(468);
        }
      }
    }
  });

  it('全部素材在同一条圆弧内叠放，数量增加时压缩间距而不扩大展开范围', () => {
    const layout = calculateReferenceFan({ x: 400, y: 400 }, { width: 1200, height: 800 }, 20);
    expect(layout.items).toHaveLength(20);
    expect(layout.inward).toBe(false);
    expect(layout.items[0]).toMatchObject({ rotate: 0 });
    expect(layout.items[19]).toMatchObject({ rotate: -90 });
    for (let index = 0; index < layout.items.length; index++) {
      const item = layout.items[index];
      expect(Math.hypot(item.x, item.y)).toBeCloseTo(96);
      if (index > 0) {
        expect(item.rotate).toBeLessThan(layout.items[index - 1].rotate);
        expect(Math.hypot(item.x - layout.items[index - 1].x, item.y - layout.items[index - 1].y)).toBeLessThan(64);
      }
    }
  });

  it('单张居中并朝向圆心，空引用不产生卡片', () => {
    const single = calculateReferenceFan({ x: 400, y: 400 }, { width: 1200, height: 800 }, 1).items[0];
    expect(single.x).toBeLessThan(0);
    expect(single.x).toBeCloseTo(single.y);
    expect(single.rotate).toBe(-45);
    expect(calculateReferenceFan({ x: 400, y: 400 }, { width: 1200, height: 800 }, 0).items).toEqual([]);
  });

  it('芯片预览读取实时标题和输出，删除的节点使用可辨认的占位状态', () => {
    const nodes = [{ id: 'text', data: { type: 'ai-text', label: '新标题', output: '最新输出', displayId: 13 } as BaseNodeData }];
    expect(resolveMentionPreview(nodes, 'text', '旧标题')).toMatchObject({ label: '新标题', text: '最新输出', displayId: 13, outputType: 'text', missing: false });
    expect(resolveMentionPreview([], 'deleted', '已引用素材')).toMatchObject({ label: '已引用素材', missing: true });
  });

  it('宫格引用预览对应裁片，替换图优先于主图，并兼容单行宫格', () => {
    const nodes = [{ id: 'sb', data: { type: 'ai-storyboard', imageUrl: 'grid.png', storyboardRows: 1, storyboardCols: 2, storyboardOverrides: [null, { url: 'override.png' }] } as BaseNodeData }];
    expect(resolveMentionPreview(nodes, 'sb/cell/0', '第一格')).toMatchObject({ label: '第一格', sprite: { backgroundSize: '200% 100%', backgroundPosition: '0% 0%' } });
    expect(resolveMentionPreview(nodes, 'sb/cell/1', '第二格')).toMatchObject({ thumbnailUrl: 'override.png', sprite: undefined });
    expect(resolveMentionPreview(nodes, 'sb/cell/9', '不存在的格子').thumbnailUrl).toBeUndefined();
  });

  it('视频悬浮预览分离真实视频与封面，缺封面仍提供同源抽帧输入', () => {
    const videoUrl = 'https://media.test/clip.mp4?token=preview';
    const data = { type: 'source-video', videoUrl, thumbnailUrl: videoUrl, filePath: 'C:/media/clip.mp4' } as BaseNodeData;
    expect(resolveMentionPreview([{ id: 'video', data }], 'video', '视频')).toMatchObject({
      outputType: 'video', thumbnailUrl: undefined, videoUrl, filePath: data.filePath, missing: false,
    });
    expect(resolveMentionPreview([{ id: 'video', data: { ...data, thumbnailUrl: 'cover.png' } }], 'video', '视频'))
      .toMatchObject({ outputType: 'video', thumbnailUrl: 'cover.png', videoUrl });
    expect(resolveMentionPreview([{ id: 'video', data: { type: 'ai-video' } as BaseNodeData }], 'video', '待生成'))
      .toMatchObject({ outputType: 'video', thumbnailUrl: undefined, videoUrl: undefined, missing: false });
  });

  it('单镜预览读取实时融合提示词，按 ID 跟随改号，删除时不退回整表内容', () => {
    const data = { type: 'ai-shotlist', label: '新表名', output: '旧整表输出', shotlistRows: [
      { id: 'row/a', shotNo: '7', content: '站在门口', dialogue: '先别开灯。', audio: '脚步声' },
      { id: 'another', shotNo: '8', content: '其他镜头内容' },
    ] } as BaseNodeData;
    const preview = resolveMentionPreview([{ id: 'sheet', data }], 'sheet/shot/row%2Fa', '旧表名 · 镜1');
    expect(preview).toMatchObject({ label: '镜7 · 新表名', outputType: 'text', missing: false, thumbnailUrl: undefined });
    for (const text of ['站在门口', '先别开灯。', '脚步声']) expect(preview.text).toContain(text);
    expect(preview.text).not.toContain('旧整表输出');
    expect(preview.text).not.toContain('其他镜头内容');
    expect(resolveMentionPreview([{ id: 'sheet', data }], 'sheet/shot/deleted', '已删除镜头'))
      .toMatchObject({ missing: true, text: '', description: '分镜表 · 镜头已删除或引用失效' });
    expect(resolveMentionPreview([], 'sheet/shot/row%2Fa', '已删除镜头表')).toMatchObject({ missing: true, text: '' });
  });

  it('2.5 倍悬浮时把相邻缩略图推开并保留原间距', () => {
    expect(CONNECTED_PREVIEW_THUMB_SIZE).toBe(48);
    const maxScale = 2.5;
    const nearScale = 1.16;
    const offset = calculateDockOffset(1, 0, maxScale, nearScale);
    const centerDistance = CONNECTED_PREVIEW_THUMB_SIZE + CONNECTED_PREVIEW_GAP + offset;
    const requiredDistance = CONNECTED_PREVIEW_THUMB_SIZE * maxScale / 2
      + CONNECTED_PREVIEW_THUMB_SIZE * nearScale / 2
      + CONNECTED_PREVIEW_GAP;

    expect(centerDistance).toBeCloseTo(requiredDistance);
  });

  it('按实际入边映射缩略图，包含重复边和分组继承边', () => {
    const nodes = [
      { id: 'target', parentId: 'target-group' },
      { id: 'target-group', type: 'group' },
      { id: 'source' },
      { id: 'source-group', type: 'group' },
      { id: 'group-child', parentId: 'source-group' },
      { id: 'unrelated' },
    ];
    const edges = [
      { id: 'direct-1', source: 'source', target: 'target' },
      { id: 'direct-2', source: 'source', target: 'target' },
      { id: 'inherited', source: 'source-group', target: 'target-group' },
      { id: 'other', source: 'unrelated', target: 'elsewhere' },
    ];

    const edgeIds = getConnectedPreviewEdgeIds(nodes, edges, 'target');
    expect(edgeIds.get('source')).toEqual(['direct-1', 'direct-2']);
    expect(edgeIds.get('group-child')).toEqual(['inherited']);
    expect(edgeIds.has('unrelated')).toBe(false);
  });

  it('位置和无关内容变化复用引用结果，上游内容、成员与断连仍实时更新', () => {
    const data = { type: 'ai-text', label: '素材' } as BaseNodeData;
    const nodes = [
      { id: 'child-2', parentId: 'source-group', data },
      { id: 'target', parentId: 'target-group', data },
      { id: 'target-group', type: 'group', data },
      { id: 'source', data },
      { id: 'source-group', type: 'group', data },
      { id: 'child-1', parentId: 'source-group', data },
      { id: 'unrelated', data },
    ];
    const edges = [
      { id: 'direct', source: 'source', target: 'target' },
      { id: 'group-1', source: 'source-group', target: 'target-group' },
      { id: 'group-2', source: 'source-group', target: 'target' },
    ];
    const select = createConnectedPreviewSelector();
    const initial = select(nodes, edges, 'target');
    expect(initial.map((node) => node.id)).toEqual(['child-2', 'source', 'child-1']);
    expect(initial[0].edgeIds).toEqual(['group-1', 'group-2']);
    expect(initial[1].edgeIds).toEqual(['direct']);

    const moved = nodes.map((node) => ({ ...node, position: { x: 100, y: 200 } }));
    expect(select(moved, edges, 'target')).toBe(initial);
    const unrelatedChanged = moved.map((node) => node.id === 'unrelated'
      ? { ...node, data: { ...data, output: '无关输出' } } : node);
    expect(select(unrelatedChanged, edges, 'target')).toBe(initial);
    const updated = unrelatedChanged.map((node) => node.id === 'source'
      ? { ...node, data: { ...data, output: '最新输出' } } : node);
    const refreshed = select(updated, edges, 'target');
    expect(refreshed).not.toBe(initial);
    expect(refreshed[1].data.output).toBe('最新输出');
    expect(refreshed[0].edgeIds).toBe(initial[0].edgeIds);

    const reparented = updated.map((node) => node.id === 'child-1' ? { ...node, parentId: undefined } : node);
    expect(select(reparented, edges, 'target').map((node) => node.id)).toEqual(['child-2', 'source']);
    const disconnected = select(reparented, edges.slice(0, 2), 'target');
    expect(disconnected[0].edgeIds).toEqual(['group-1']);
    expect(select(reparented, edges, 'unrelated')).toEqual([]);
    expect(select([...reparented].reverse(), edges, 'target').map((node) => node.id)).toEqual(['source', 'child-2']);
  });

  it('长按达到阈值后触发全屏', () => {
    vi.useFakeTimers();
    const onTrigger = vi.fn();
    const controller = createConnectedPreviewLongPressController(onTrigger, 500, 8);

    controller.start('node-1', {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: 20,
      clientY: 30,
    });
    vi.advanceTimersByTime(500);

    expect(onTrigger).toHaveBeenCalledWith('node-1');
  });

  it('长按过程中移动超过容差会取消', () => {
    vi.useFakeTimers();
    const onTrigger = vi.fn();
    const controller = createConnectedPreviewLongPressController(onTrigger, 500, 8);

    controller.start('node-1', {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: 20,
      clientY: 30,
    });
    controller.move({ pointerId: 1, clientX: 29, clientY: 30 });
    vi.advanceTimersByTime(500);

    expect(onTrigger).not.toHaveBeenCalled();
  });
});
