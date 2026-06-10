/**
 * CanvasBackground — 根据 config.canvasBackground 渲染对应的画布背景主题
 */
import { useAppStore } from '../../store/useAppStore';
import SolarSystemBackground from './SolarSystemBackground';
import type { CanvasBackground as CanvasBg } from '../../types';

/** 背景主题配置 */
export const BACKGROUND_OPTIONS: { value: CanvasBg; label: string; preview: string }[] = [
  { value: 'default', label: '默认暗色', preview: 'canvas-bg' },
  { value: 'solar-system', label: '太阳系', preview: 'solar-system' },
  { value: 'minimal', label: '极简纯黑', preview: 'minimal' },
];

export default function CanvasBackground() {
  const canvasBackground = useAppStore((s) => s.config.canvasBackground);

  switch (canvasBackground) {
    case 'solar-system':
      return <SolarSystemBackground />;
    case 'minimal':
      return <div className="canvas-bg-minimal" />;
    default:
      return null; // 默认暗色由 app-box 自身的 bg-canvas-bg 提供
  }
}
