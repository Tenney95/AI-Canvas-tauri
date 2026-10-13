import type { AppearanceTheme, AppearanceMode, AppearanceButtonColors, AppearanceBackgroundImage } from '../../types';

const BUTTON_UI = {
  radius: 7,
  borderWidth: 1,
  normal: { background: 'auto', hoverBackground: 'auto', text: 'auto', border: 'auto' },
  primary: { background: 'auto', hoverBackground: 'auto', text: 'auto', border: 'auto' },
} as const;

const DARK_UI = {
  background: '#0a0a0f',
  surface: '#14141c',
  card: '#1a1a26',
  hover: '#252535',
  border: '#2a2a3a',
  text: '#dddde4',
  textSecondary: '#8888a0',
  textMuted: '#7d7d91',
  accent: '#6366f1',
  accentStrong: '#818cf8',
  accentSoft: '#a5b4fc',
  focus: '#6366f1',
  success: '#22c55e',
  warning: '#f97316',
  danger: '#ef4444',
  info: '#3b82f6',
  radius: 8,
  shadowOpacity: 0.42,
  glassOpacity: 0.77,
  glassBlur: 16,
  scrollbar: '#3a3a50',
  scrollbarHover: '#555570',
  button: BUTTON_UI,
} as const;

const LIGHT_UI = {
  background: '#F4F6FB',
  surface: '#FFFFFF',
  card: '#F8FAFD',
  hover: '#EEF1F8',
  border: '#E4E8F2',
  text: '#33364D',
  textSecondary: '#6E7488',
  textMuted: '#767D92',
  accent: '#7280E4',
  accentStrong: '#5A69D4',
  accentSoft: '#4F5ECB',
  focus: '#7280E4',
  success: '#23937A',
  warning: '#C06E33',
  danger: '#CE4F62',
  info: '#3B7EC4',
  radius: 8,
  shadowOpacity: 0.18,
  glassOpacity: 0.7,
  glassBlur: 16,
  scrollbar: '#b3bdce',
  scrollbarHover: '#8996aa',
  button: BUTTON_UI,
} as const;

function completeTheme(
  id: string,
  name: string,
  mode: AppearanceMode,
  ui: typeof DARK_UI | typeof LIGHT_UI,
  canvas: AppearanceTheme['canvas'],
): AppearanceTheme {
  const now = 0;
  return {
    schemaVersion: 1,
    id,
    name,
    builtin: true,
    mode,
    ui: { ...ui, button: { ...ui.button, normal: { ...ui.button.normal }, primary: { ...ui.button.primary } } },
    canvas,
    // These values intentionally match the pre-appearance baseline node defaults.
    node: {
      background: ui.surface,
      backgroundOpacity: 0.94,
      border: ui.border,
      borderWidth: 0,
      radius: 12,
      shadow: `0 12px 32px color-mix(in srgb, #000 42%, transparent)`,
      headerBackground: ui.card,
      selectedBorder: ui.accent,
      selectedGlow: `color-mix(in srgb, ${ui.accent} 20%, transparent)`,
      text: ui.text,
      handleColor: ui.accent,
    },
    edge: {
      color: mode === 'light' ? '#B1B1B7' : '#33334a',
      width: 1.5,
      selectedColor: ui.accent,
      selectedWidth: 2.5,
      flowColor: mode === 'light' ? '#5A69D4' : '#818cf8',
      previewColor: ui.accent,
      animationEnabled: true,
    },
    handle: {
      kind: 'color',
      color: ui.accent,
      hoverColor: ui.accentStrong,
      size: 40,
      imageFit: 'contain',
      opacity: 1,
    },
    motion: { enabled: true, scale: 1 },
    createdAt: now,
    updatedAt: now,
  };
}

export function createBuiltinAppearanceThemes(): AppearanceTheme[] {
  return [
    completeTheme('standard-dark', '深色', 'dark', DARK_UI, {
      kind: 'color', color: '#0a0a0f', imageFit: 'cover', imagePosition: 'center',
      imageOpacity: 1, gridVisible: true, gridColor: '#585868', gridSize: 8,
    }),
    completeTheme('standard-light', '浅色', 'light', LIGHT_UI, {
      kind: 'color', color: '#F4F6FB', imageFit: 'cover', imagePosition: 'center',
      imageOpacity: 1, gridVisible: true, gridColor: '#B1B1B7', gridSize: 8,
    }),
    completeTheme('solar-system', '太阳系', 'dark', DARK_UI, {
      kind: 'solar-system', color: '#000000', imageFit: 'cover', imagePosition: 'center',
      imageOpacity: 1, gridVisible: true, gridColor: '#3a3a50', gridSize: 8,
    }),
    completeTheme('frosted-warm-light', '磨砂暖光', 'light', LIGHT_UI, {
      kind: 'frosted-glass', color: '#d9dad9', imageFit: 'cover', imagePosition: 'center',
      imageOpacity: 1, gridVisible: true, gridColor: '#a9aaa8', gridSize: 8,
    }),
  ];
}

export function cloneAppearanceTheme(theme: AppearanceTheme, id: string, name: string): AppearanceTheme {
  const now = Date.now();
  return {
    ...structuredClone(theme),
    id,
    name,
    builtin: false,
    createdAt: now,
    updatedAt: now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeAppearanceBackgroundImage(input: unknown): AppearanceBackgroundImage | undefined {
  if (!isRecord(input)) return undefined;
  // 仅接受随主题携带的图片，不把外部 URL、文件路径或 CSS 片段交给背景样式；SVG 仅作图片加载。
  const imageDataUrl = typeof input.imageDataUrl === 'string'
    && /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[a-z0-9+/]+={0,2}$/i.test(input.imageDataUrl)
    ? input.imageDataUrl : undefined;
  return {
    kind: input.kind === 'image' ? 'image' : 'color',
    imageDataUrl,
    imageFit: input.imageFit === 'contain' || input.imageFit === 'fill' ? input.imageFit : 'cover',
  };
}

function normalizeButtonColors(input: unknown): AppearanceButtonColors {
  const source = isRecord(input) ? input : {};
  const color = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : 'auto';
  return {
    background: color(source.background),
    hoverBackground: color(source.hoverBackground),
    backgroundImage: normalizeAppearanceBackgroundImage(source.backgroundImage),
    hoverBackgroundImage: normalizeAppearanceBackgroundImage(source.hoverBackgroundImage),
    text: color(source.text),
    border: color(source.border),
  };
}

/**
 * 补齐旧版或外部导入的半成品快照。持久化数据是不可信输入，运行时不能只依赖 TS 类型。
 */
export function normalizeAppearanceTheme(input: unknown): AppearanceTheme {
  const source = isRecord(input) ? input : {};
  const mode = source.mode === 'light' || source.mode === 'system' ? source.mode : 'dark';
  const requestedId = typeof source.id === 'string' ? source.id : '';
  const base = getBuiltinAppearanceTheme(requestedId, mode === 'light' ? 'light' : 'dark');
  const ui = isRecord(source.ui) ? source.ui : {};
  const button = isRecord(ui.button) ? ui.button : {};
  const canvas = isRecord(source.canvas) ? source.canvas : {};
  const node = isRecord(source.node) ? source.node : {};
  const edge = isRecord(source.edge) ? source.edge : {};
  const handle = isRecord(source.handle) ? source.handle : {};
  const motion = isRecord(source.motion) ? source.motion : {};
  return {
    ...base,
    ...source,
    schemaVersion: 1,
    id: requestedId || base.id,
    name: typeof source.name === 'string' && source.name.trim() ? source.name : base.name,
    builtin: typeof source.builtin === 'boolean' ? source.builtin : base.builtin,
    mode,
    ui: {
      ...base.ui,
      ...ui,
      surfaceImage: normalizeAppearanceBackgroundImage(ui.surfaceImage),
      button: {
        radius: typeof button.radius === 'number' && Number.isFinite(button.radius)
          ? Math.max(0, Math.min(24, button.radius)) : BUTTON_UI.radius,
        borderWidth: typeof button.borderWidth === 'number' && Number.isFinite(button.borderWidth)
          ? Math.max(0, Math.min(3, button.borderWidth)) : BUTTON_UI.borderWidth,
        normal: normalizeButtonColors(button.normal),
        primary: normalizeButtonColors(button.primary),
      },
    },
    canvas: { ...base.canvas, ...canvas },
    node: { ...base.node, ...node, backgroundImage: normalizeAppearanceBackgroundImage(node.backgroundImage) },
    edge: { ...base.edge, ...edge },
    handle: {
      ...base.handle,
      ...handle,
      kind: handle.kind === 'image' || handle.kind === 'color'
        ? handle.kind
        : typeof handle.imageDataUrl === 'string' && handle.imageDataUrl.length > 0 ? 'image' : base.handle.kind,
    },
    motion: { ...base.motion, ...motion },
    createdAt: typeof source.createdAt === 'number' ? source.createdAt : base.createdAt,
    updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : base.updatedAt,
  } as AppearanceTheme;
}

export function getBuiltinAppearanceTheme(id: string, mode: 'dark' | 'light' = 'dark'): AppearanceTheme {
  return createBuiltinAppearanceThemes().find((theme) => theme.id === id)
    ?? createBuiltinAppearanceThemes().find((theme) => theme.id === `standard-${mode}`)!;
}
