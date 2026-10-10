import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateDockOffset,
  calculateReferenceFan,
  CONNECTED_PREVIEW_GAP,
  CONNECTED_PREVIEW_THUMB_SIZE,
  REFERENCE_FAN_THUMB_SIZE,
  createConnectedPreviewLongPressController,
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
