import { Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ToolbarButtonDef } from '../../src/types';

vi.mock('../../src/components/nodes/shared/toolbar/toolbarRegistry', () => ({ TOOLBAR_MORE_KEY: 'more' }));
vi.mock('../../src/components/nodes/shared/toolbar/ToolbarMoreMenu', () => ({
  default: ({ items, renderItem }: { items: ToolbarButtonDef[]; renderItem: (key: string) => ReactNode }) => (
    <aside>{items.map((item) => <Fragment key={item.key}>{renderItem(item.key)}</Fragment>)}</aside>
  ),
}));

import ToolbarZones from '../../src/components/nodes/shared/toolbar/ToolbarZones';

describe('工具栏共享分区', () => {
  it.each([undefined, 'ftb-divider pano-toolbar-divider'])('保留自定义排序、插件、隐藏项和分隔样式 %s', (dividerClassName) => {
    const hiddenButtons = [{ key: 'hidden', label: '隐藏项', icon: 'mdi:test', defaultZone: 'first' }];
    const html = renderToStaticMarkup(<ToolbarZones
      zones={[
        { id: 'first', name: '首区', buttonKeys: ['plugin:tool', 'missing', 'more'] },
        { id: 'empty', name: '空区', buttonKeys: [] },
        { id: 'last', name: '末区', buttonKeys: ['preset'] },
      ]}
      hiddenButtons={hiddenButtons}
      renderButton={(key) => key === 'missing' ? null : <button key={key}>{key}</button>}
      dividerClassName={dividerClassName}
    />);
    expect(html.indexOf('plugin:tool')).toBeLessThan(html.indexOf('<aside>'));
    expect(html.indexOf('hidden')).toBeLessThan(html.indexOf('preset'));
    expect(html).not.toContain('missing');
    expect((html.match(/img-toolbar-zone nodrag/g) ?? [])).toHaveLength(3);
    const divider = dividerClassName ?? 'ftb-divider img-toolbar-main-divider';
    expect(html.split(`class="${divider}"`)).toHaveLength(3);
  });

  it('空布局不产生容器，单区保留更多入口且无分隔线', () => {
    const renderButton = vi.fn(() => null);
    expect(renderToStaticMarkup(<ToolbarZones zones={[]} hiddenButtons={[]} renderButton={renderButton} />)).toBe('');
    const html = renderToStaticMarkup(<ToolbarZones
      zones={[{ id: 'only', name: '唯一区', buttonKeys: ['more'] }]}
      hiddenButtons={[]}
      renderButton={renderButton}
    />);
    expect(html).toContain('<aside></aside>');
    expect(html).not.toContain('ftb-divider');
    expect(renderButton).not.toHaveBeenCalled();
  });
});
