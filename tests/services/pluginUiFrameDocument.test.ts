import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginUiFrameDocument } from '../../src/services/plugins/pluginUiFrameDocument';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('plugin frame CSP', () => {
  it('requires a matching bootstrap marker and CSP before creating a blob', () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost/' } });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:frame');
    expect(() => createPluginUiFrameDocument('<script src="/wrong.js"></script>', '/safe.js', new URLSearchParams({ session: 'test' }))).toThrow();
    expect(create).not.toHaveBeenCalled();
    const page = createPluginUiFrameDocument('<meta content="script-src \'self\' "><script src="/safe.js"></script>', '/safe.js', new URLSearchParams({ session: 'test' }));
    expect(page.src).toBe('blob:frame#session=test');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
