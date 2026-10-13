import { describe, expect, it, vi } from 'vitest';
import { createBuiltinAppearanceThemes, normalizeAppearanceTheme } from '../../src/services/appearance/appearanceDefaults';
import { migrateLegacyAppearance } from '../../src/services/appearance/appearanceMigration';
import { applyAppearanceTheme, resolveAppearanceTheme } from '../../src/services/appearance/appearanceRuntime';
import type { AppConfig } from '../../src/types';

const BACKGROUND_IMAGE = {
  kind: 'image' as const,
  imageFit: 'fill' as const,
  imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2WQAAAAASUVORK5CYII=',
};

const SVG_BACKGROUND_IMAGE = {
  ...BACKGROUND_IMAGE,
  imageDataUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiIGZpbGw9InJlZCIvPjwvc3ZnPg==',
};

describe('appearance themes', () => {
  it.each(['https://example.com/image.png', 'file:///private/image.png', 'data:text/html;base64,PHN2Zy8+', 'data:image/png;base64,abc") ; color:red'])('rejects background source %s without changing its color fallback', (imageDataUrl) => {
    const theme = normalizeAppearanceTheme({
      ui: { surfaceImage: { ...BACKGROUND_IMAGE, imageDataUrl }, button: { normal: { background: '#123456', backgroundImage: { ...BACKGROUND_IMAGE, imageDataUrl } } } },
      node: { background: '#345678', backgroundImage: { ...BACKGROUND_IMAGE, imageDataUrl } },
    });
    expect(theme.ui.surfaceImage?.imageDataUrl).toBeUndefined();
    expect(theme.ui.button.normal.backgroundImage?.imageDataUrl).toBeUndefined();
    expect(theme.node.backgroundImage?.imageDataUrl).toBeUndefined();
    expect(theme.ui.button.normal.background).toBe('#123456');
    expect(theme.node.background).toBe('#345678');
  });

  it('keeps background images when the system palette changes', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    try {
      const theme = normalizeAppearanceTheme({
        id: 'standard-dark', mode: 'system',
        ui: { surfaceImage: BACKGROUND_IMAGE, button: { normal: { backgroundImage: BACKGROUND_IMAGE } } },
        node: { backgroundImage: BACKGROUND_IMAGE },
        canvas: { kind: 'image', imageDataUrl: BACKGROUND_IMAGE.imageDataUrl, imageFit: 'fill' },
      });
      const resolved = resolveAppearanceTheme(theme);
      expect(resolved.mode).toBe('light');
      expect(resolved.ui.surface).toBe('#FFFFFF');
      expect(resolved.ui.surfaceImage).toEqual(BACKGROUND_IMAGE);
      expect(resolved.node.backgroundImage).toEqual(BACKGROUND_IMAGE);
      expect(resolved.ui.button.normal.backgroundImage).toEqual(BACKGROUND_IMAGE);
      expect(resolved.canvas).toMatchObject({ kind: 'image', imageDataUrl: BACKGROUND_IMAGE.imageDataUrl, imageFit: 'fill' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { format: 'PNG', image: BACKGROUND_IMAGE },
    { format: 'SVG', image: SVG_BACKGROUND_IMAGE },
  ])('inherits hover images, allows color overrides, and clears images on preset reset ($format)', ({ image }) => {
    const values = new Map<string, string>();
    vi.stubGlobal('document', { documentElement: {
      dataset: {}, setAttribute: vi.fn(),
      style: { setProperty: (name: string, value: string) => values.set(name, value), removeProperty: (name: string) => values.delete(name) },
    } });
    try {
      const base = createBuiltinAppearanceThemes()[0];
      const theme = normalizeAppearanceTheme({
        ...base,
        ui: { ...base.ui, surfaceImage: image, button: {
          ...base.ui.button,
          normal: { ...base.ui.button.normal, backgroundImage: image },
          primary: { ...base.ui.button.primary, backgroundImage: image },
        } },
        node: { ...base.node, backgroundImage: image },
      });
      applyAppearanceTheme(theme);
      for (const token of ['--button-bg', '--button-hover-bg', '--button-secondary-bg', '--button-primary-bg', '--button-primary-hover-bg', '--appearance-node-background', '--appearance-surface-image']) {
        expect(values.get(token)).toContain(image.imageDataUrl);
        expect(values.get(token)).toContain('/ 100% 100% no-repeat');
      }
      theme.ui.button.normal.hoverBackgroundImage = { kind: 'color', imageFit: 'cover' };
      applyAppearanceTheme(theme);
      expect(values.get('--button-hover-bg')).toBe('var(--white-alpha-08)');
      expect(values.get('--button-bg')).toContain(image.imageDataUrl);
      applyAppearanceTheme(base);
      expect(values.get('--appearance-surface-image')).toBe('none');
      expect([...values.values()].some((value) => value.includes('data:image'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retains embedded SVG backgrounds in a serialized preset', () => {
    const theme = normalizeAppearanceTheme({
      ui: { surfaceImage: SVG_BACKGROUND_IMAGE, button: { primary: { backgroundImage: SVG_BACKGROUND_IMAGE } } },
      node: { backgroundImage: SVG_BACKGROUND_IMAGE },
    });
    const restored = normalizeAppearanceTheme(JSON.parse(JSON.stringify(theme)));
    expect(restored.ui.surfaceImage).toEqual(SVG_BACKGROUND_IMAGE);
    expect(restored.ui.button.primary.backgroundImage).toEqual(SVG_BACKGROUND_IMAGE);
    expect(restored.node.backgroundImage).toEqual(SVG_BACKGROUND_IMAGE);
  });

  it('uses short runtime URLs for large images, reuses them, and releases them after reset', () => {
    const values = new Map<string, string>();
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:appearance-large-image');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    vi.stubGlobal('document', { documentElement: {
      dataset: {}, setAttribute: vi.fn(),
      style: { setProperty: (name: string, value: string) => values.set(name, value), removeProperty: (name: string) => values.delete(name) },
    } });
    try {
      // 超过 Chromium 2MiB 变量限制的编码；关注显示 URL 与持久化数据的边界。
      const image = { ...BACKGROUND_IMAGE, imageDataUrl: `data:image/png;base64,${'AAAA'.repeat(550 * 1024)}` };
      const base = createBuiltinAppearanceThemes()[1];
      const theme = normalizeAppearanceTheme({
        ...base,
        ui: { ...base.ui, surfaceImage: image, button: { ...base.ui.button, normal: { ...base.ui.button.normal, backgroundImage: image } } },
        node: { ...base.node, backgroundImage: image },
      });
      applyAppearanceTheme(theme);
      for (const token of ['--button-bg', '--button-hover-bg', '--button-secondary-bg', '--appearance-node-background', '--appearance-surface-image']) {
        expect(values.get(token)).toContain('blob:appearance-large-image');
        expect(values.get(token)!.length).toBeLessThan(1024);
      }
      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(createObjectURL.mock.calls[0][0]).toMatchObject({ type: 'image/png', size: 550 * 1024 * 3 });
      expect(theme.node.backgroundImage?.imageDataUrl).toBe(image.imageDataUrl);
      expect(theme.ui.surfaceImage?.imageDataUrl).toBe(image.imageDataUrl);
      theme.node.backgroundImage!.imageFit = 'contain';
      applyAppearanceTheme(theme);
      expect(values.get('--appearance-node-background')).toContain('/ contain no-repeat');
      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(revokeObjectURL).not.toHaveBeenCalled();
      applyAppearanceTheme(base);
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:appearance-large-image');
      expect([...values.values()].some((value) => value.includes('blob:'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ships complete snapshots for every built-in preset', () => {
    const themes = createBuiltinAppearanceThemes();
    expect(themes.map((theme) => theme.id)).toEqual([
      'standard-dark', 'standard-light', 'solar-system', 'frosted-warm-light',
    ]);
    for (const theme of themes) {
      expect(theme.ui).toBeDefined();
      expect(theme.canvas).toBeDefined();
      expect(theme.node).toBeDefined();
      expect(theme.edge).toBeDefined();
      expect(theme.handle).toBeDefined();
      expect(theme.motion).toBeDefined();
    }
    expect(themes.find((theme) => theme.id === 'solar-system')?.node.background).toBe('#14141c');
    const dark = themes.find((theme) => theme.id === 'standard-dark');
    expect(dark?.ui).toEqual(expect.objectContaining({
      surface: '#14141c',
      accent: '#6366f1',
      card: '#1a1a26',
    }));
    expect(dark?.canvas).toEqual(expect.objectContaining({
      kind: 'color',
      color: '#0a0a0f',
      gridColor: '#585868',
    }));
    expect(dark?.node).toEqual(expect.objectContaining({
      background: '#14141c',
      border: '#2a2a3a',
      borderWidth: 0,
      radius: 12,
      selectedBorder: '#6366f1',
    }));
    expect(dark?.edge).toEqual(expect.objectContaining({
      color: '#33334a',
      flowColor: '#818cf8',
    }));
    expect(dark?.handle).toEqual(expect.objectContaining({
      kind: 'color',
      color: '#6366f1',
      hoverColor: '#818cf8',
    }));
    const light = themes.find((theme) => theme.id === 'standard-light');
    expect(light?.canvas).toEqual(expect.objectContaining({ kind: 'color', color: '#F4F6FB', gridColor: '#B1B1B7' }));
    expect(light?.ui).toEqual(expect.objectContaining({ text: '#33364D', textSecondary: '#6E7488', border: '#E4E8F2' }));
    expect(light?.edge.color).toBe('#B1B1B7');
  });

  it('maps legacy canvas settings into one complete appearance snapshot', () => {
    const config = {
      providers: {},
      theme: 'light',
      canvasBackground: 'custom',
      customBackgroundUrl: 'data:image/png;base64,fixture',
      customBackgroundOpacity: 0.4,
    } as AppConfig;
    const theme = migrateLegacyAppearance(config);
    expect(theme.mode).toBe('light');
    expect(theme.canvas.kind).toBe('image');
    expect(theme.canvas.imageDataUrl).toContain('data:image/png');
    expect(theme.canvas.imageOpacity).toBe(0.4);
    expect(theme.node).toBeDefined();
    expect(theme.edge).toBeDefined();
    expect(theme.handle).toBeDefined();
  });

  it('fills missing sections in older persisted snapshots', () => {
    const theme = normalizeAppearanceTheme({ id: 'old-custom', name: '旧主题', mode: 'dark', ui: { accent: '#ff00aa' } });
    expect(theme.id).toBe('old-custom');
    expect(theme.ui.accent).toBe('#ff00aa');
    expect(theme.motion.enabled).toBe(true);
    expect(theme.canvas.gridVisible).toBe(true);
    expect(theme.edge.color).toBeDefined();
    expect(theme.handle.size).toBe(40);
    expect(theme.handle.kind).toBe('color');
  });

  it('infers image handle mode for older themes that only stored the image data', () => {
    const theme = normalizeAppearanceTheme({
      id: 'old-image-handle',
      handle: { imageDataUrl: 'data:image/png;base64,fixture' },
    });
    expect(theme.handle.kind).toBe('image');
  });

  it('fills old button snapshots, retains partial overrides, and bounds imported dimensions', () => {
    const old = normalizeAppearanceTheme({ id: 'old-button-theme', ui: { accent: '#c24172' } });
    expect(old.ui.button).toEqual({
      radius: 7, borderWidth: 1,
      normal: { background: 'auto', hoverBackground: 'auto', text: 'auto', border: 'auto' },
      primary: { background: 'auto', hoverBackground: 'auto', text: 'auto', border: 'auto' },
    });
    const partial = normalizeAppearanceTheme({ ui: { button: { radius: -3, borderWidth: 99, primary: { background: '#c24172', text: null } } } });
    expect(partial.ui.button.radius).toBe(0);
    expect(partial.ui.button.borderWidth).toBe(3);
    expect(partial.ui.button.primary.background).toBe('#c24172');
    expect(partial.ui.button.primary.text).toBe('auto');
    expect(partial.ui.button.normal.background).toBe('auto');
    const malformed = normalizeAppearanceTheme({ ui: { button: { radius: NaN, borderWidth: Infinity, normal: [] } } });
    expect(malformed.ui.button).toEqual(old.ui.button);
  });

  it('keeps explicit button settings while the system mode resolves the built-in palette', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    try {
      const theme = normalizeAppearanceTheme({ id: 'standard-dark', mode: 'system', ui: { button: { radius: 0, primary: { background: '#c24172' } } } });
      const resolved = resolveAppearanceTheme(theme);
      expect(resolved.mode).toBe('light');
      expect(resolved.ui.surface).toBe('#FFFFFF');
      expect(resolved.ui.button.radius).toBe(0);
      expect(resolved.ui.button.primary.background).toBe('#c24172');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('preserves valid custom colors while normalizing the surrounding snapshot', () => {
    const theme = normalizeAppearanceTheme({
      id: 'custom-colors',
      mode: 'dark',
      ui: {
        accent: '#ffffff',
        accentStrong: '#ffffff',
        surface: '#141414',
        card: '#171717',
        hover: '#262626',
        border: '#363636',
      },
      canvas: { kind: 'color', color: '#141414', gridColor: '#474747' },
      node: { background: '#262626', border: '#363636', selectedBorder: '#a8a8a8' },
      edge: { color: '#86909C', flowColor: '#6bb6fb', previewColor: '#86909C' },
    });

    expect(theme.ui).toEqual(expect.objectContaining({
      accent: '#ffffff',
      accentStrong: '#ffffff',
      surface: '#141414',
      card: '#171717',
      hover: '#262626',
      border: '#363636',
    }));
    expect(theme.canvas).toEqual(expect.objectContaining({ color: '#141414', gridColor: '#474747' }));
    expect(theme.node).toEqual(expect.objectContaining({ background: '#262626', border: '#363636', selectedBorder: '#a8a8a8' }));
    expect(theme.edge).toEqual(expect.objectContaining({ color: '#86909C', flowColor: '#6bb6fb', previewColor: '#86909C' }));
  });

  it('derives every brand alpha token from the active accent color', () => {
    const values = new Map<string, string>();
    const root = {
      dataset: {},
      setAttribute: vi.fn(),
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        removeProperty: (name: string) => values.delete(name),
      },
    } as unknown as HTMLElement;
    vi.stubGlobal('document', { documentElement: root });

    try {
      const base = createBuiltinAppearanceThemes()[0];
      applyAppearanceTheme({ ...base, ui: { ...base.ui, accent: '#c24172' } });

      for (const opacity of [4, 5, 8, 10, 12, 15, 20, 25, 30, 40, 50, 80]) {
        const token = `--brand-alpha-${String(opacity).padStart(2, '0')}`;
        expect(values.get(token)).toBe(`color-mix(in srgb, #c24172 ${opacity}%, transparent)`);
      }
      expect(values.get('--tw-indigo-500')).toBe('194 65 114');
      expect(values.get('--white-alpha-10')).toBe('color-mix(in srgb, #ffffff 10%, transparent)');
      expect(values.get('--black-alpha-50')).toBe('rgba(0, 0, 0, 0.5)');
      expect(values.get('--theme-bg')).toBe('#0a0a0f');
      expect(values.get('--theme-surface')).toBe('#14141c');
      expect(values.get('--glass-panel-bg')).toBe('#14141c');
      expect(values.get('--theme-card')).toBe('#1a1a26');
      expect(values.get('--theme-hover')).toBe('#252535');
      expect(values.get('--theme-border')).toBe('#2a2a3a');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['dark', 'light'] as const)('derives status backgrounds from custom colors in %s mode', (mode) => {
    const values = new Map<string, string>();
    const root = {
      dataset: {},
      setAttribute: vi.fn(),
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        removeProperty: (name: string) => values.delete(name),
      },
    } as unknown as HTMLElement;
    vi.stubGlobal('document', { documentElement: root });

    try {
      const base = createBuiltinAppearanceThemes().find((theme) => theme.mode === mode)!;
      const colors = { success: '#168a63', info: '#2874b8', warning: '#b86418', danger: '#cc3256' };
      applyAppearanceTheme({ ...base, ui: { ...base.ui, ...colors } });

      for (const [status, color] of Object.entries(colors)) {
        const opacity = mode === 'dark' ? 15 : status === 'warning' ? 22 : status === 'danger' ? 18 : 20;
        expect(values.get(`--${status}`)).toBe(color);
        expect(values.get(`--${status}-bg`)).toBe(`color-mix(in srgb, ${color} ${opacity}%, transparent)`);
      }
      expect(values.get('--danger-pale')).toBe(mode === 'dark' ? '#dd788f' : '#a72947');

      applyAppearanceTheme(base);
      expect(values.get('--danger-bg')).toBe(`color-mix(in srgb, ${base.ui.danger} ${mode === 'dark' ? 15 : 18}%, transparent)`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['dark', 'light'] as const)('applies custom buttons and restores automatic tokens in %s mode', (mode) => {
    const values = new Map<string, string>();
    const root = {
      dataset: {},
      setAttribute: vi.fn(),
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        removeProperty: (name: string) => values.delete(name),
      },
    } as unknown as HTMLElement;
    vi.stubGlobal('document', { documentElement: root });
    try {
      const base = createBuiltinAppearanceThemes().find((theme) => theme.mode === mode)!;
      const custom = normalizeAppearanceTheme({
        ...base,
        ui: { ...base.ui, button: {
          radius: 0, borderWidth: 0,
          normal: { background: '#123456', hoverBackground: '#234567', text: '#ddeeff', border: 'none' },
          primary: { background: '#ffffff', hoverBackground: '#eeeeee', text: 'auto', border: '#765432' },
        } },
      });
      applyAppearanceTheme(custom);
      expect(values.get('--button-bg')).toBe('#123456');
      expect(values.get('--button-secondary-bg')).toBe('#123456');
      expect(values.get('--button-hover-bg')).toBe('#234567');
      expect(values.get('--button-text')).toBe('#ddeeff');
      expect(values.get('--button-border')).toBe('transparent');
      expect(values.get('--button-primary-bg')).toBe('#ffffff');
      expect(values.get('--button-primary-hover-bg')).toBe('#eeeeee');
      expect(values.get('--button-primary-text')).toBe('#111827');
      expect(values.get('--button-primary-border')).toBe('#765432');
      for (const token of ['--button-radius', '--button-radius-sm', '--button-radius-lg', '--button-border-width']) {
        expect(values.get(token)).toBe('0px');
      }
      applyAppearanceTheme(base);
      expect(values.get('--button-bg')).toBe('var(--white-alpha-04)');
      expect(values.get('--button-secondary-bg')).toBe('var(--theme-surface)');
      expect(values.get('--button-primary-bg')).toBe('var(--brand)');
      expect(values.get('--button-primary-hover-bg')).toBe('var(--brand-hover)');
      expect(values.get('--button-radius')).toBe('7px');
      expect(values.get('--button-radius-sm')).toBe('6px');
      expect(values.get('--button-radius-lg')).toBe('12px');
      expect(values.get('--button-border-width')).toBe('1px');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the solar preset neutral and restores its translucent panels', () => {
    const values = new Map<string, string>();
    const root = {
      dataset: {},
      setAttribute: vi.fn(),
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        removeProperty: (name: string) => values.delete(name),
      },
    } as unknown as HTMLElement;
    vi.stubGlobal('document', { documentElement: root });

    try {
      const solar = createBuiltinAppearanceThemes().find((theme) => theme.id === 'solar-system')!;
      applyAppearanceTheme(solar);
      expect(values.get('--theme-surface')).toBe('#14141c');
      expect(values.get('--theme-card')).toBe('#1a1a26');
      expect(values.get('--theme-hover')).toBe('#252535');
      expect(values.get('--theme-border')).toBe('#2a2a3a');
      expect(values.get('--glass-panel-bg')).toBe('color-mix(in srgb, #14141c 77%, transparent)');
      expect(values.get('--brand')).toBe('#6366f1');
      expect(values.get('--node-image')).toBeUndefined();
      applyAppearanceTheme({ ...solar, ui: { ...solar.ui, surface: '#ffffff', card: '#f4f4f4' } });
      expect(values.get('--glass-panel-bg')).toBe('#ffffff');
      expect(values.get('--glass-bg-node')).toBe('#f4f4f4');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('correctly maps "transparent" / "none" / "无" border and background colors to transparent in CSS variables', () => {
    const values = new Map<string, string>();
    const root = {
      dataset: {},
      setAttribute: vi.fn(),
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        removeProperty: (name: string) => values.delete(name),
      },
    } as unknown as HTMLElement;
    vi.stubGlobal('document', { documentElement: root });

    try {
      const base = createBuiltinAppearanceThemes()[0];
      applyAppearanceTheme({
        ...base,
        node: {
          ...base.node,
          background: 'transparent',
          border: 'none',
          selectedBorder: '无',
        },
        canvas: {
          ...base.canvas,
          gridColor: 'transparent',
        },
      });

      expect(values.get('--appearance-node-background')).toBe('transparent');
      expect(values.get('--appearance-node-border')).toBe('transparent');
      expect(values.get('--appearance-node-selected-border')).toBe('transparent');
      expect(values.get('--canvas-grid-color')).toBe('transparent');
      expect(values.get('--appearance-node-radius')).toBe(`${base.node.radius}px`);
      expect(values.get('--appearance-node-radius-inner')).toBe(`${Math.max(0, base.node.radius - 4)}px`);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
