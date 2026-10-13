/**
 * CanvasBackground — 根据 config.canvasBackground 渲染对应的画布背景主题
 */
import { lazy, Suspense, useSyncExternalStore } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { installSystemAppearanceListener, resolveAppearanceMode, resolveAppearanceTheme } from '../../services/appearance/appearanceRuntime';
import { resolveThemeImageSource } from '../../services/fs/themeAssets';

// 懒加载：两个主题背景引入 three / postprocessing（体积大户），仅在选中对应主题时才加载
const SolarSystemBackground = lazy(() => import('./SolarSystemBackground'));
const NebulaBackground = lazy(() => import('./NebulaBackground'));
const FrostedGlassBackground = lazy(() => import('./FrostedGlassBackground'));
const subscribeSystemMode = (onChange: () => void) => installSystemAppearanceListener(onChange);
const getSystemMode = () => resolveAppearanceMode('system');
const getServerMode = () => 'dark' as const;

export default function CanvasBackground() {
  useSyncExternalStore(subscribeSystemMode, getSystemMode, getServerMode);
  const canvasBackground = useAppStore((s) => s.config.canvasBackground);
  const appearance = useAppStore((s) => s.config.appearance);
  const appearancePreview = useAppStore((s) => s.appearancePreview);
  const defaultDarkBackgroundShade = useAppStore((s) => s.config.defaultDarkBackgroundShade);
  const offWhiteBackgroundColor = useAppStore((s) => s.config.offWhiteBackgroundColor);
  const customBgUrl = useAppStore((s) => s.config.customBackgroundUrl);
  const customBgOpacity = useAppStore((s) => s.config.customBackgroundOpacity);
  const performanceMode = useAppStore((s) => s.config.performanceMode === true);
  const currentAppearance = appearancePreview ?? appearance;
  const resolvedAppearance = currentAppearance ? resolveAppearanceTheme(currentAppearance) : undefined;
  const backgroundKind = resolvedAppearance?.canvas?.kind ?? canvasBackground ?? 'default';
  const backgroundColor = resolvedAppearance?.canvas?.color ?? offWhiteBackgroundColor;
  const backgroundImage = resolveThemeImageSource(resolvedAppearance?.canvas?.imageDataUrl ?? customBgUrl);
  const backgroundOpacity = resolvedAppearance?.canvas?.imageOpacity ?? customBgOpacity;

  if (performanceMode && (
    backgroundKind === 'solar-system'
    || backgroundKind === 'nebula'
    || backgroundKind === 'frosted-glass'
    || backgroundKind === 'custom'
    || backgroundKind === 'image'
  )) {
    return <div className="absolute inset-0 z-0 pointer-events-none bg-canvas-bg" />;
  }

  switch (backgroundKind) {
    case 'solar-system':
      return <Suspense fallback={null}><SolarSystemBackground /></Suspense>;
    case 'nebula':
      return <Suspense fallback={null}><NebulaBackground /></Suspense>;
    case 'off-white':
      return (
        <div
          className="canvas-bg-off-white"
          style={backgroundColor
            ? { backgroundColor }
            : undefined}
        />
      );
    case 'color':
      return (
        <div
          className="absolute inset-0 z-0 pointer-events-none"
          style={{ backgroundColor: backgroundColor || 'var(--theme-bg)' }}
        />
      );
    case 'frosted-glass':
      return <Suspense fallback={null}><FrostedGlassBackground /></Suspense>;
    case 'minimal':
      return <div className="canvas-bg-minimal" />;
    case 'custom':
    case 'image':
      if (!backgroundImage) return null;
      return (
        <div
          className="absolute inset-0 z-0"
          style={{
            backgroundImage: `url(${backgroundImage})`,
            backgroundSize: resolvedAppearance?.canvas?.imageFit === 'fill' ? '100% 100%' : resolvedAppearance?.canvas?.imageFit ?? 'cover',
            backgroundPosition: resolvedAppearance?.canvas?.imagePosition ?? 'center',
            backgroundRepeat: 'no-repeat',
            opacity: backgroundOpacity ?? 0.3,
          }}
        />
      );
    default: {
      const shade = Math.min(58, Math.max(0, defaultDarkBackgroundShade ?? 20));
      return (
        <div
          className="absolute inset-0 z-0 pointer-events-none"
          style={{ backgroundColor: `rgb(${shade} ${shade} ${shade})` }}
        />
      );
    }
  }
}
