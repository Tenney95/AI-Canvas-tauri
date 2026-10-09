import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({ reduceMotion: false }));
vi.mock('framer-motion', async () => ({
  ...await vi.importActual<typeof import('framer-motion')>('framer-motion'),
  useReducedMotion: () => driver.reduceMotion,
}));
vi.mock('react-dom', () => ({ createPortal: (element: unknown) => element }));
vi.mock('../../src/hooks/useDialogFocus', () => ({ useDialogFocus: vi.fn() }));
vi.mock('../../src/i18n', () => ({ useT: () => (value: string) => value }));

import FullscreenOverlay from '../../src/components/shared/FullscreenOverlay';
import { useDialogFocus } from '../../src/hooks/useDialogFocus';

beforeEach(() => { driver.reduceMotion = false; vi.stubGlobal('document', { body: {} }); });

describe('全屏预览的焦点边界与生命周期', () => {
  it('减少动态效果时保留淡入，不再缩放或移动面板', () => {
    driver.reduceMotion = true;
    const markup = renderToStaticMarkup(
      <FullscreenOverlay isOpen onClose={vi.fn()} title="文本预览">内容</FullscreenOverlay>,
    );
    expect(markup).toContain('opacity:0');
    expect(markup).not.toMatch(/scale\(|translate3d\(/);
    expect(markup).toContain('transform:none');
  });

  it.each([false, true])('普通与无面板模式都有命名的模态语义：hidePanel=%s', (hidePanel) => {
    const close = vi.fn();
    const markup = renderToStaticMarkup(
      <FullscreenOverlay isOpen onClose={close} title="镜头参考图" hidePanel={hidePanel}>
        <button type="button">预览操作</button>
      </FullscreenOverlay>,
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-label="镜头参考图"');
    expect(markup).toContain('tabindex="-1"');
    expect(useDialogFocus).toHaveBeenCalledWith(true, expect.objectContaining({ current: null }), close, { escapeOnKeyUp: true });
  });

  it('无标题的媒体预览仍有可访问名称', () => {
    const markup = renderToStaticMarkup(
      <FullscreenOverlay isOpen onClose={vi.fn()} hidePanel><img alt="素材" /></FullscreenOverlay>,
    );
    expect(markup).toContain('aria-label="全屏预览"');
  });

  it.each([{ hidePanel: true }, { unmountOnClose: true }])('关闭时立即移除重媒体并停止焦点约束：%j', (options) => {
    const markup = renderToStaticMarkup(
      <FullscreenOverlay isOpen={false} onClose={vi.fn()} {...options}>
        <video src="fixture.mp4" controls />
      </FullscreenOverlay>,
    );
    expect(markup).toBe('');
    expect(useDialogFocus).toHaveBeenCalledWith(false, expect.anything(), expect.any(Function), { escapeOnKeyUp: true });
  });
});
