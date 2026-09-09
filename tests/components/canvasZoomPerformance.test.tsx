import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import GooeyBtn from '../../src/components/nodes/shared/GooeyBtn';

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
    expect(new Set([...html.matchAll(/<filter id="([^"]+)"/g)].map((match) => match[1])).size).toBe(200);
  });
});
