/**
 * canvasZoomPerformance — 回归测试：canvas connection button zoom。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import GooeyBtn, { CanvasHandleFilter } from '../../src/components/nodes/shared/GooeyBtn';

describe('canvas connection button zoom', () => {
  it('renders many connection buttons without a React Flow store subscription', () => {
    // 独立渲染没有 ReactFlowProvider：如果按钮重新依赖视口 Store，此测试会直接失败。
    const html = renderToStaticMarkup(
      <div>
        {Array.from({ length: 200 }, (_, index) => (
          <GooeyBtn key={index} className={index % 2 ? 'gooey-btn-right' : 'gooey-btn-left'} hue={142} />
        ))}
      </div>,
    );

    expect((html.match(/<button /g) ?? [])).toHaveLength(200);
    expect((html.match(/gooey-btn-left/g) ?? [])).toHaveLength(100);
    expect((html.match(/gooey-btn-right/g) ?? [])).toHaveLength(100);
    expect(html).not.toContain('--gooey-inv-zoom:');
    // 节点重挂载不能插入全局样式表，画布外独立使用的按钮各自持有滤镜。
    expect(html).not.toContain('<style');
    const filterIds = [...html.matchAll(/<filter id="([^"]+)"/g)].map((match) => match[1]);
    const filterReferences = [...html.matchAll(/--gooey-filter:url\(#([^)]*)\)/g)].map((match) => match[1]);
    expect(new Set(filterIds).size).toBe(200);
    expect(filterReferences).toEqual(filterIds);
  });

  it('shares one persistent filter per canvas while retaining every native button', () => {
    const handles = (count: number) => Array.from({ length: count }, (_, i) => (
      <GooeyBtn key={i} className="gooey-btn-right" hue={234} ariaLabel={`端口 ${i}`} />
    ));
    const html = renderToStaticMarkup(<>
      <CanvasHandleFilter>{handles(154)}</CanvasHandleFilter>
      <CanvasHandleFilter>{handles(2)}</CanvasHandleFilter>
    </>);
    const ids = [...html.matchAll(/<filter id="([^"]+)"/g)].map((match) => match[1]);
    const refs = [...html.matchAll(/--gooey-filter:url\(#([^)]*)\)/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(refs).toEqual([...Array<string>(154).fill(ids[0]), ids[1], ids[1]]);
    expect(html.match(/<button /g)).toHaveLength(156);
  });
});
