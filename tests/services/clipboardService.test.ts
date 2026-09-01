import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyImage } from '../../src/services/clipboardService';

class ClipboardItemMock {
  readonly data: Record<string, Promise<string | Blob>>;

  static supports(type: string) {
    return type === 'image/png';
  }

  constructor(data: Record<string, Promise<string | Blob>>) {
    this.data = data;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clipboardService.copyImage', () => {
  it('在图片读取完成前调用 clipboard.write，保留 WebKit 用户手势', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchPending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const write = vi.fn(async (items: ClipboardItemMock[]) => {
      const blob = await items[0].data['image/png'];
      expect(blob).toBeInstanceOf(Blob);
      expect((blob as Blob).type).toBe('image/png');
    });
    vi.stubGlobal('fetch', vi.fn(() => fetchPending));
    vi.stubGlobal('ClipboardItem', ClipboardItemMock);
    vi.stubGlobal('navigator', { clipboard: { write } });

    const result = copyImage('data:image/png;base64,cG5n');
    expect(write).toHaveBeenCalledTimes(1);

    resolveFetch({
      ok: true,
      status: 200,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    } as Response);
    await expect(result).resolves.toBe(true);
  });
});
