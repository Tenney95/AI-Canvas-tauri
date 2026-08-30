import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSafeImage } from '../../src/components/nodes/shared/image/imageUtils';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadSafeImage pre-decode guard', () => {
  it('reads encoded dimensions and runs the budget callback before image.decode()', async () => {
    const pngHeader = new Uint8Array(24);
    pngHeader.set([0x89, 0x50, 0x4e, 0x47], 0);
    pngHeader.set([0x49, 0x48, 0x44, 0x52], 12);
    new DataView(pngHeader.buffer).setUint32(16, 8192, false);
    new DataView(pngHeader.buffer).setUint32(20, 4096, false);

    const order: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob([pngHeader], { type: 'image/png' }),
    })));
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:prepared-image'),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal('Image', class {
      src = '';
      naturalWidth = 8192;
      naturalHeight = 4096;
      async decode() { order.push('decode'); }
    });

    await loadSafeImage('blob:test-image', {
      beforeDecode: (dimensions) => {
        order.push(`budget:${dimensions.width}x${dimensions.height}`);
      },
    });

    expect(order).toEqual(['budget:8192x4096', 'decode']);
  });

  it('revokes the prepared object URL when the budget callback rejects the decode', async () => {
    const pngHeader = new Uint8Array(24);
    pngHeader.set([0x89, 0x50, 0x4e, 0x47], 0);
    pngHeader.set([0x49, 0x48, 0x44, 0x52], 12);
    new DataView(pngHeader.buffer).setUint32(16, 4096, false);
    new DataView(pngHeader.buffer).setUint32(20, 4096, false);

    const revokeObjectURL = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob([pngHeader], { type: 'image/png' }),
    })));
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:rejected-image'),
      revokeObjectURL,
    });
    vi.stubGlobal('Image', class {
      src = '';
      async decode() { throw new Error('decode should not run'); }
    });

    await expect(loadSafeImage('blob:test-image', {
      beforeDecode: () => {
        throw new RangeError('budget exceeded');
      },
    })).rejects.toThrow('budget exceeded');

    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:rejected-image');
  });
});
