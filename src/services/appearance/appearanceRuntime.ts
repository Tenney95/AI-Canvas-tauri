import type { AppearanceBackgroundImage, AppearanceMode, AppearanceTheme } from '../../types';
import { getBuiltinAppearanceTheme, normalizeAppearanceBackgroundImage, normalizeAppearanceTheme } from './appearanceDefaults';
import { resolveThemeImageSource } from '../fs/themeAssets';

export function resolveAppearanceMode(mode: AppearanceMode | undefined): 'dark' | 'light' {
  if (mode === 'dark' || mode === 'light') return mode;
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}
/** Resolve the complete built-in snapshot used by the system mode. */
export function resolveAppearanceTheme(theme: AppearanceTheme): AppearanceTheme {
  const normalized = normalizeAppearanceTheme(theme);
  if (normalized.mode === 'system' && (normalized.id === 'standard-dark' || normalized.id === 'standard-light')) {
    const systemTheme = getBuiltinAppearanceTheme(`standard-${resolveAppearanceMode('system')}`);
    return {
      ...systemTheme,
      ui: { ...systemTheme.ui, button: normalized.ui.button, surfaceImage: normalized.ui.surfaceImage },
      node: { ...systemTheme.node, backgroundImage: normalized.node.backgroundImage },
      canvas: normalized.canvas.kind === 'image' ? normalized.canvas : systemTheme.canvas,
    };
  }
  return normalized;
}

export function isTransparentColor(val: string | undefined | null): boolean {
  if (!val) return false;
  const lower = val.trim().toLowerCase();
  return (
    lower === 'transparent' ||
    lower === 'none' ||
    lower === '无' ||
    lower === 'rgba(0, 0, 0, 0)' ||
    lower === 'rgba(0,0,0,0)'
  );
}

function setVar(root: HTMLElement, name: string, value: string | number): void {
  root.style.setProperty(name, String(value));
}

function resolveButtonColor(color: string, fallback: string): string {
  return color === 'auto' ? fallback : isTransparentColor(color) ? 'transparent' : color;
}

const runtimeImageUrls = new WeakMap<HTMLElement, Map<string, string>>();
// Chromium 的 CSS 变量上限为 2MiB；提前将大图转为短 URL，留出变量组合的余量。
const INLINE_IMAGE_LIMIT = 1024 * 1024;

function createRuntimeImageResolver(root: HTMLElement) {
  let urls = runtimeImageUrls.get(root);
  if (!urls) {
    urls = new Map<string, string>();
    runtimeImageUrls.set(root, urls);
  }
  const cache = urls;
  const used = new Set<string>();
  return {
    resolve(dataUrl: string): string | undefined {
      if (dataUrl.length <= INLINE_IMAGE_LIMIT) return resolveThemeImageSource(dataUrl);
      const cached = cache.get(dataUrl);
      if (cached) {
        used.add(dataUrl);
        return cached;
      }
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/i.exec(dataUrl);
      if (!match || typeof URL.createObjectURL !== 'function') return undefined;
      try {
        const binary = atob(match[2]);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const url = URL.createObjectURL(new Blob([bytes], { type: match[1] }));
        cache.set(dataUrl, url);
        used.add(dataUrl);
        return url;
      } catch {
        return undefined;
      }
    },
    releaseUnused() {
      for (const [dataUrl, url] of cache) {
        if (used.has(dataUrl)) continue;
        URL.revokeObjectURL(url);
        cache.delete(dataUrl);
      }
    },
  };
}

function appearanceImageLayer(
  image: AppearanceBackgroundImage | undefined,
  resolveImageUrl: (dataUrl: string) => string | undefined = resolveThemeImageSource,
): string {
  const safe = normalizeAppearanceBackgroundImage(image);
  if (safe?.kind !== 'image' || !safe.imageDataUrl) return 'none';
  const imageUrl = resolveImageUrl(safe.imageDataUrl);
  if (!imageUrl) return 'none';
  const size = safe.imageFit === 'fill' ? '100% 100%' : safe.imageFit;
  return `url("${imageUrl}") center / ${size} no-repeat`;
}

/** 图片只替换底色的视觉来源，不改变文字、边框、子控件或交互透明度。 */
export function resolveAppearanceBackground(
  color: string,
  image?: AppearanceBackgroundImage,
  resolveImageUrl?: (dataUrl: string) => string | undefined,
): string {
  const layer = appearanceImageLayer(image, resolveImageUrl);
  return layer === 'none' ? color : `${layer}, linear-gradient(${color}, ${color})`;
}

function brandAlphaVars(accent: string): Record<string, string> {
  return Object.fromEntries([4, 5, 8, 10, 12, 15, 20, 25, 30, 40, 50, 80].map((opacity) => [
    `--brand-alpha-${String(opacity).padStart(2, '0')}`,
    `color-mix(in srgb, ${accent} ${opacity}%, transparent)`,
  ]));
}

/**
 * Alpha tokens are used by shared settings and panel styles. Keep their base
 * color aligned with the active appearance instead of leaving them tied to
 * the original dark/light defaults in base.css.
 */
function themeAlphaVars(text: string, mode: 'dark' | 'light'): Record<string, string> {
  const overlayBase = mode === 'dark' ? '#ffffff' : text;
  const whiteAlphas = [3, 4, 5, 6, 8, 10, 12, 15].map((opacity) => [
    `--white-alpha-${String(opacity).padStart(2, '0')}`,
    `color-mix(in srgb, ${overlayBase} ${opacity}%, transparent)`,
  ] as const);
  const blackAlphas = [30, 40, 50, 60].map((opacity) => [
    `--black-alpha-${opacity}`,
    `rgba(0, 0, 0, ${opacity / 100})`,
  ] as const);
  return Object.fromEntries([...whiteAlphas, ...blackAlphas]);
}

function hexToRgb(value: string): [number, number, number] | null {
  const match = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return null;
  return [
    Number.parseInt(match[1].slice(0, 2), 16),
    Number.parseInt(match[1].slice(2, 4), 16),
    Number.parseInt(match[1].slice(4, 6), 16),
  ];
}

export function contrastColor(value: string): string {
  const rgb = hexToRgb(value);
  if (!rgb) return '#ffffff';
  const channels = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.58 ? '#111827' : '#ffffff';
}

function mixHex(value: string, target: string, targetWeight: number): string {
  const sourceRgb = hexToRgb(value);
  const targetRgb = hexToRgb(target);
  if (!sourceRgb || !targetRgb) return value;
  const weight = Math.max(0, Math.min(1, targetWeight));
  return `#${sourceRgb.map((channel, index) => Math.round(channel + (targetRgb[index] - channel) * weight).toString(16).padStart(2, '0')).join('')}`;
}

function applyAccentScale(root: HTMLElement, accent: string, mode: 'dark' | 'light'): void {
  const shades: Record<string, string> = mode === 'light'
    ? {
      '50': mixHex(accent, '#ffffff', 0.95),
      '100': mixHex(accent, '#ffffff', 0.82),
      '200': mixHex(accent, '#ffffff', 0.62),
      '300': mixHex(accent, '#000000', 0.18),
      '400': mixHex(accent, '#000000', 0.30),
      '500': accent,
      '600': mixHex(accent, '#000000', 0.42),
    }
    : {
      '50': mixHex(accent, '#ffffff', 0.92),
      '100': mixHex(accent, '#ffffff', 0.78),
      '200': mixHex(accent, '#ffffff', 0.55),
      '300': mixHex(accent, '#ffffff', 0.34),
      '400': mixHex(accent, '#ffffff', 0.18),
      '500': accent,
      '600': mixHex(accent, '#000000', 0.18),
    };
  for (const [shade, color] of Object.entries(shades)) {
    const rgb = hexToRgb(color);
    if (rgb) setVar(root, `--tw-indigo-${shade}`, rgb.join(' '));
  }
}

export function applyAppearanceTheme(theme: AppearanceTheme | null | undefined): void {
  if (typeof document === 'undefined' || !theme) return;
  theme = normalizeAppearanceTheme(theme);
  const root = document.documentElement;
  const mode = resolveAppearanceMode(theme.mode);
  const resolvedTheme = resolveAppearanceTheme(theme);
  const { ui, node, edge, handle } = resolvedTheme;
  const { button } = ui;
  // URL 仅属于当前窗口的显示运行时；原始数据仍随主题持久化及跨窗口同步。
  const imageUrls = createRuntimeImageResolver(root);
  const background = (color: string, image?: AppearanceBackgroundImage) => resolveAppearanceBackground(color, image, imageUrls.resolve);
  // 背景、面板、卡片和边框保持预设原值；主题色只用于选中态和强调控件。
  const themeBackground = isTransparentColor(ui.background) ? 'transparent' : ui.background;
  const themeSurface = isTransparentColor(ui.surface) ? 'transparent' : ui.surface;
  const themeCard = isTransparentColor(ui.card) ? 'transparent' : ui.card;
  const themeHover = isTransparentColor(ui.hover) ? 'transparent' : ui.hover;
  const themeBorder = isTransparentColor(ui.border) ? 'transparent' : ui.border;
  // 未改动的太阳系预设保留旧版玻璃层次；用户改动任一界面底色后，组件直接呈现配置值。
  const solarGlass = resolvedTheme.id === 'solar-system'
    && themeSurface.toLowerCase() === '#14141c'
    && themeCard.toLowerCase() === '#1a1a26'
    && themeHover.toLowerCase() === '#252535'
    && themeBorder.toLowerCase() === '#2a2a3a';
  const glassSurface = solarGlass
    ? `color-mix(in srgb, ${themeSurface} ${Math.round(ui.glassOpacity * 100)}%, transparent)`
    : themeSurface;

  root.setAttribute('data-theme', mode);
  root.setAttribute('data-appearance-id', theme.id);
  root.dataset.appearanceCanvas = resolvedTheme.canvas.kind;
  root.dataset.appearanceMotion = resolvedTheme.motion.enabled ? 'enabled' : 'reduced';

  const vars: Record<string, string | number> = {
    '--theme-bg': themeBackground,
    '--theme-surface': themeSurface,
    '--theme-card': themeCard,
    '--theme-hover': themeHover,
    '--theme-border': themeBorder,
    '--theme-text': ui.text,
    '--theme-text-secondary': ui.textSecondary,
    '--theme-text-muted': ui.textMuted,
    '--theme-input-bg': mode === 'light' ? '#FFFFFF' : 'rgba(0, 0, 0, 0.25)',
    '--theme-border-subtle': themeBorder === 'transparent' ? 'transparent' : `color-mix(in srgb, ${themeBorder} 58%, transparent)`,
    '--separator-color': themeBorder === 'transparent' ? 'transparent' : `color-mix(in srgb, ${themeBorder} 72%, transparent)`,
    '--border-subtle': themeBorder === 'transparent' ? 'transparent' : `color-mix(in srgb, ${themeBorder} 58%, transparent)`,
    '--border-secondary': themeBorder,
    '--brand': ui.accent,
    '--brand-light': ui.accentStrong,
    '--brand-hover': ui.accentStrong,
    '--brand-pale': ui.accentSoft,
    '--brand-contrast': contrastColor(ui.accent),
    '--button-radius': `${button.radius}px`,
    '--button-radius-sm': `${Math.round(button.radius * 6 / 7)}px`,
    '--button-radius-lg': `${Math.round(button.radius * 12 / 7)}px`,
    '--button-border-width': `${button.borderWidth}px`,
    '--button-bg': background(resolveButtonColor(button.normal.background, 'var(--white-alpha-04)'), button.normal.backgroundImage),
    '--button-hover-bg': background(resolveButtonColor(button.normal.hoverBackground, 'var(--white-alpha-08)'), button.normal.hoverBackgroundImage ?? button.normal.backgroundImage),
    '--button-text': resolveButtonColor(button.normal.text, 'var(--theme-text)'),
    '--button-border': resolveButtonColor(button.normal.border, 'var(--white-alpha-08)'),
    '--button-hover-border': resolveButtonColor(button.normal.border, 'var(--white-alpha-12)'),
    '--button-secondary-bg': background(resolveButtonColor(button.normal.background, 'var(--theme-surface)'), button.normal.backgroundImage),
    '--button-secondary-hover-bg': background(resolveButtonColor(button.normal.hoverBackground, 'var(--theme-hover)'), button.normal.hoverBackgroundImage ?? button.normal.backgroundImage),
    '--button-secondary-border': resolveButtonColor(button.normal.border, 'var(--theme-border)'),
    '--button-secondary-hover-border': resolveButtonColor(button.normal.border, 'var(--border-secondary)'),
    '--button-primary-bg': background(resolveButtonColor(button.primary.background, 'var(--brand)'), button.primary.backgroundImage),
    '--button-primary-hover-bg': background(resolveButtonColor(button.primary.hoverBackground, 'var(--brand-hover)'), button.primary.hoverBackgroundImage ?? button.primary.backgroundImage),
    '--button-primary-text': resolveButtonColor(button.primary.text, contrastColor(button.primary.background === 'auto' ? ui.accent : button.primary.background)),
    '--button-primary-border': resolveButtonColor(button.primary.border, 'color-mix(in srgb, var(--brand) 80%, var(--theme-text))'),
    '--button-primary-hover-border': resolveButtonColor(button.primary.border, 'var(--brand-hover)'),
    ...brandAlphaVars(ui.accent),
    ...themeAlphaVars(ui.text, mode),
    '--border-focus': `color-mix(in srgb, ${ui.focus} 55%, transparent)`,
    '--success': ui.success,
    '--success-light': ui.success,
    '--success-text': ui.success,
    '--success-bg': `color-mix(in srgb, ${ui.success} ${mode === 'light' ? 20 : 15}%, transparent)`,
    '--warning': ui.warning,
    '--warning-light': ui.warning,
    '--warning-bg': `color-mix(in srgb, ${ui.warning} ${mode === 'light' ? 22 : 15}%, transparent)`,
    '--danger': ui.danger,
    '--danger-light': ui.danger,
    '--danger-pale': mixHex(ui.danger, mode === 'light' ? '#000000' : '#ffffff', mode === 'light' ? 0.18 : 0.34),
    '--danger-bg': `color-mix(in srgb, ${ui.danger} ${mode === 'light' ? 18 : 15}%, transparent)`,
    '--info': ui.info,
    '--info-light': ui.info,
    '--info-bg': `color-mix(in srgb, ${ui.info} ${mode === 'light' ? 20 : 15}%, transparent)`,
    '--canvas-edge': isTransparentColor(edge.color) ? 'transparent' : edge.color,
    '--appearance-edge-color': isTransparentColor(edge.color) ? 'transparent' : edge.color,
    '--appearance-edge-selected': isTransparentColor(edge.selectedColor) ? 'transparent' : edge.selectedColor,
    '--appearance-edge-flow': isTransparentColor(edge.flowColor) ? 'transparent' : edge.flowColor,
    '--appearance-edge-preview': isTransparentColor(edge.previewColor) ? 'transparent' : edge.previewColor,
    '--appearance-edge-width': edge.width,
    '--appearance-edge-selected-width': edge.selectedWidth,
    '--appearance-node-background': background(isTransparentColor(node.background)
      ? 'transparent'
      : `color-mix(in srgb, ${node.background} ${Math.round(node.backgroundOpacity * 100)}%, transparent)`, node.backgroundImage),
    '--appearance-node-border': isTransparentColor(node.border) ? 'transparent' : node.border,
    '--appearance-node-header': isTransparentColor(node.headerBackground) ? 'transparent' : node.headerBackground,
    '--appearance-node-text': node.text,
    '--appearance-node-selected-border': isTransparentColor(node.selectedBorder) ? 'transparent' : node.selectedBorder,
    '--appearance-node-selected-glow': isTransparentColor(node.selectedGlow) ? 'transparent' : node.selectedGlow,
    '--appearance-node-radius': `${node.radius}px`,
    '--appearance-node-radius-inner': `${Math.max(0, node.radius - 4)}px`,
    '--appearance-node-border-width': `${node.borderWidth}px`,
    '--appearance-handle-color': isTransparentColor(handle.color) ? 'transparent' : handle.color,
    '--appearance-handle-hover': isTransparentColor(handle.hoverColor) ? 'transparent' : handle.hoverColor,
    '--appearance-handle-size': `${handle.size}px`,
    '--appearance-handle-opacity': handle.opacity,
    '--appearance-radius': `${ui.radius}px`,
    '--appearance-glass-opacity': ui.glassOpacity,
    '--appearance-glass-blur': `${ui.glassBlur}px`,
    '--glass-bg': glassSurface,
    '--glass-panel-bg': glassSurface,
    '--appearance-surface-image': appearanceImageLayer(ui.surfaceImage, imageUrls.resolve),
    '--glass-bg-light': solarGlass ? `color-mix(in srgb, ${themeSurface} 45%, transparent)` : themeSurface,
    '--glass-bg-node': solarGlass
      ? `color-mix(in srgb, ${themeCard} ${Math.round(ui.glassOpacity * 100)}%, transparent)`
      : themeCard,
    '--glass-bevel-bg': glassSurface,
    '--glass-bevel-border': `linear-gradient(160deg, color-mix(in srgb, ${themeBorder} 92%, white) 0%, ${themeBorder} 48%, color-mix(in srgb, ${themeBorder} 78%, black) 100%)`,
    '--glass-ring': themeBorder,
    '--glass-ring-strong': `color-mix(in srgb, ${themeBorder} 70%, transparent)`,
    '--glass-blur-sm': `${Math.max(2, Math.round(ui.glassBlur * 0.4))}px`,
    '--glass-blur-md': `${ui.glassBlur}px`,
    '--glass-blur-lg': `${Math.round(ui.glassBlur * 1.5)}px`,
    '--scrollbar-thumb': ui.scrollbar,
    '--scrollbar-thumb-hover': ui.scrollbarHover,
    '--canvas-grid-color': isTransparentColor(resolvedTheme.canvas.gridColor) ? 'transparent' : resolvedTheme.canvas.gridColor,
    '--canvas-grid-size': `${resolvedTheme.canvas.gridSize}px`,
    '--floating-surface-bg': mode === 'light' ? 'color-mix(in srgb, #ffffff 70%, transparent)' : glassSurface,
  };
  for (const [name, value] of Object.entries(vars)) setVar(root, name, value);
  applyAccentScale(root, ui.accent, mode);
  const handleImageUrl = handle.kind === 'image' && handle.imageDataUrl ? imageUrls.resolve(handle.imageDataUrl) : undefined;
  const useHandleImage = Boolean(handleImageUrl);
  setVar(root, '--appearance-handle-image', useHandleImage ? `url("${handleImageUrl}")` : 'none');
  setVar(root, '--appearance-handle-image-opacity', useHandleImage ? handle.opacity : 0);
  setVar(root, '--appearance-handle-image-fit', handle.imageFit === 'fill' ? '100% 100%' : handle.imageFit);

  // 保留图像、视频、音频等语义色；只有文本节点沿用主题强调色。
  setVar(root, '--node-text', ui.accent);
  setVar(root, '--node-text-light', ui.accentStrong);
  setVar(root, '--node-text-bg', `color-mix(in srgb, ${ui.accent} 15%, transparent)`);
  for (const prefix of ['image', 'video', 'audio', 'panorama', 'markdown']) {
    root.style.removeProperty(`--node-${prefix}`);
    root.style.removeProperty(`--node-${prefix}-light`);
    root.style.removeProperty(`--node-${prefix}-bg`);
  }
  // 所有变量更新后再撤销旧 URL，切换纯色或预设时释放不再使用的图片。
  imageUrls.releaseUnused();
}

export function installSystemAppearanceListener(onChange: () => void): () => void {
  const media = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: light)') : undefined;
  if (!media) return () => {};
  if (media.addEventListener) {
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }
  media.addListener?.(onChange);
  return () => media.removeListener?.(onChange);
}
