import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureAppWindow } from '../../../src/services/mcp/mcpUiRuntimeService';

const jpeg = vi.hoisted(() => vi.fn());
vi.mock('html-to-image', () => ({ toJpeg: jpeg }));
class ElementStub { sensitive = false; closest() { return this.sensitive ? this : null; } }
class InputStub extends ElementStub { type = 'text'; name = ''; id = ''; autocomplete = ''; }
afterEach(() => vi.unstubAllGlobals());

describe('MCP screenshot redaction', () => {
  it('handles Text and SVG-like elements while still hiding password and sensitive elements', async () => {
    vi.stubGlobal('Element', ElementStub);
    vi.stubGlobal('HTMLInputElement', InputStub);
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 600 });
    const root = { clientWidth: 1000, clientHeight: 600 };
    vi.stubGlobal('document', { getElementById: () => root, documentElement: {} });
    vi.stubGlobal('getComputedStyle', () => ({ backgroundColor: '#101018' }));
    jpeg.mockImplementation(async (_root, options) => {
      expect(options.filter({ nodeType: 3, textContent: '普通文字' })).toBe(true);
      expect(options.filter(new ElementStub())).toBe(true);
      const sensitive = new ElementStub(); sensitive.sensitive = true;
      expect(options.filter(sensitive)).toBe(false);
      const password = new InputStub(); password.type = 'password';
      expect(options.filter(password)).toBe(false);
      const token = new InputStub(); token.name = 'apiKey';
      expect(options.filter(token)).toBe(false);
      return 'data:image/jpeg;base64,YWJj';
    });
    expect(await captureAppWindow({ target: 'main', maxWidth: 640, quality: 0.8, redactSensitive: true }))
      .toEqual({ data: 'YWJj', mimeType: 'image/jpeg', width: 640, height: 384 });
  });
});
