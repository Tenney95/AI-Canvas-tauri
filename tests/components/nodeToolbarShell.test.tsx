import type { HTMLAttributes, ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({
  manual: false,
  states: [] as unknown[],
  index: 0,
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    memo: <T,>(component: T) => component,
    useState: <T,>(initial: T | (() => T)) => {
      if (!driver.manual) return actual.useState(initial);
      const index = driver.index++;
      if (!(index in driver.states)) {
        driver.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      }
      return [driver.states[index], (value: T) => { driver.states[index] = value; }];
    },
  };
});

import NodeToolbarShell from '../../src/components/nodes/shared/NodeToolbarShell';

function renderShell(visible: boolean, children: ReactNode) {
  driver.manual = true;
  driver.index = 0;
  return NodeToolbarShell({ visible, children }) as ReactElement<HTMLAttributes<HTMLDivElement>>;
}

beforeEach(() => {
  driver.manual = false;
  driver.states = [];
  driver.index = 0;
});

describe('node toolbar mount boundary', () => {
  it('does not render toolbar components for a large initially unselected canvas', () => {
    const renderToolbar = vi.fn();
    function Toolbar() {
      renderToolbar();
      return <button>插件工具</button>;
    }

    const html = renderToStaticMarkup(
      <>
        {Array.from({ length: 1000 }, (_, index) => (
          <NodeToolbarShell key={index} visible={false}><Toolbar /></NodeToolbarShell>
        ))}
      </>,
    );

    expect(renderToolbar).not.toHaveBeenCalled();
    expect(html).not.toContain('<button');
    expect((html.match(/node-toolbar-shell/g) ?? [])).toHaveLength(1000);
  });

  it('renders an initially selected toolbar immediately with the existing visibility class', () => {
    const html = renderToStaticMarkup(
      <NodeToolbarShell visible><button>复制</button></NodeToolbarShell>,
    );
    expect(html).toContain('node-toolbar-shell is-visible');
    expect(html).toContain('<button>复制</button>');
  });

  it('retains the same child position after first selection so selection changes do not unmount dialogs', () => {
    const toolbar = <section key="toolbar"><input defaultValue="未保存的布局" /></section>;
    const initiallyHidden = renderShell(false, toolbar);
    expect(initiallyHidden.props.children).toBeNull();

    const selected = renderShell(true, toolbar);
    expect(selected.props.children).toBe(toolbar);
    expect(selected.props.className).toContain('is-visible');

    const hiddenAgain = renderShell(false, toolbar);
    expect(hiddenAgain.type).toBe(selected.type);
    expect(hiddenAgain.key).toBe(selected.key);
    expect(hiddenAgain.props.children).toBe(selected.props.children);
    expect(hiddenAgain.props.className).not.toContain('is-visible');
    expect(renderShell(true, toolbar).props.children).toBe(toolbar);
  });

  it('keeps receiving current toolbar props after it has been hidden', () => {
    renderShell(true, <button disabled>处理中</button>);
    const updated = <button>处理完成</button>;
    expect(renderShell(false, updated).props.children).toBe(updated);
  });
});
