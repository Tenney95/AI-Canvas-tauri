import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '@iconify/react';
import { useAppStore } from '../../store/useAppStore';
import { getNodeTypeConfig, type AppearanceTheme, type BaseNodeData } from '../../types';
import type { Node } from '@xyflow/react';
import { getBuiltinAppearanceTheme, normalizeAppearanceTheme } from '../../services/appearance/appearanceDefaults';
import { isTransparentColor, resolveAppearanceMode, resolveAppearanceTheme } from '../../services/appearance/appearanceRuntime';
import { exportAppearanceTheme, importAppearanceTheme } from '../../services/appearance/appearanceThemeService';
import { saveBinaryToLocalFile } from '../../services/fileService';
import { isTauriEnv } from '../../services/fs/core';
import { registerSettingsProducer } from '../../services/configPersistenceQueue';
import AnimatedButton from '../shared/AnimatedButton';
import ModalOverlay from '../shared/ModalOverlay';
import Select from '../shared/Select';
import NumberStepper from '../shared/NumberStepper';
import { useT } from '../../i18n';
import mercuryImg from '../../assets/images/bg/1_mercury.png';
import venusImg from '../../assets/images/bg/2_venus.png';
import earthImg from '../../assets/images/bg/3_earth.png';
import marsImg from '../../assets/images/bg/4_mars.png';
import jupiterImg from '../../assets/images/bg/5_jupiter.png';
import saturnImg from '../../assets/images/bg/6_saturn.png';
import uranusImg from '../../assets/images/bg/7_uranus.png';
import neptuneImg from '../../assets/images/bg/8_neptune.png';

const SOLAR_SYSTEM_PLANETS = [
  { id: 'earth', name: '地球', image: earthImg },
  { id: 'jupiter', name: '木星', image: jupiterImg },
  { id: 'saturn', name: '土星', image: saturnImg },
  { id: 'mars', name: '火星', image: marsImg },
  { id: 'mercury', name: '水星', image: mercuryImg },
  { id: 'venus', name: '金星', image: venusImg },
  { id: 'uranus', name: '天王星', image: uranusImg },
  { id: 'neptune', name: '海王星', image: neptuneImg },
];

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

const DARK_THEME_COLOR_SWATCHES = [
  '#6366f1', // Indigo (Brand default)
  '#22c55e', // Emerald (Image)
  '#3b82f6', // Blue (Video)
  '#f97316', // Orange (Audio)
  '#06b6d4', // Cyan (Panorama)
  '#a855f7', // Purple (Markdown)
  '#f59e0b', // Amber (Workflow chip)
  '#ec4899', // Pink (Track color)
] as const;

const LIGHT_THEME_COLOR_SWATCHES = [
  '#7280E4', // Macaron Indigo
  '#5368d6', // Brand
  '#23937A', // Macaron Green
  '#3B7EC4', // Macaron Blue
  '#C06E33', // Macaron Orange
  '#D9943B', // Macaron Amber
  '#9867D8', // Macaron Purple
  '#CE4F62', // Macaron Red
] as const;

const DARK_CANVAS_COLOR_SWATCHES = [
  '#0a0a0f', // Baseline theme background
  '#000000', // Shade 0
  '#0F0F0F', // Shade 15
  '#141414', // Shade 20 (Original default dark shade)
  '#212121', // Shade 33
  '#3A3A3A', // Shade 58
] as const;

const LIGHT_CANVAS_COLOR_SWATCHES = [
  '#F4F6FB', // Baseline light theme background
  '#FFFFFF', // Pure white
  '#FAFBFD',
  '#ECEFF5',
  '#E4E9F2',
] as const;

function getThemeNodeSeed(themeId: string): number {
  let hash = 0;
  for (let i = 0; i < themeId.length; i++) {
    hash = (hash << 5) - hash + themeId.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

interface BlankNodeTemplate {
  type: string;
  label: string;
  icon: string;
  iconColor: string;
  badge?: string;
  kind: 'image' | 'text' | 'video' | 'audio' | 'storyboard';
}

const BLANK_NODE_TEMPLATES: BlankNodeTemplate[] = [
  {
    type: 'ai-image',
    label: '生成图像',
    icon: 'mdi:image-outline',
    iconColor: '#22c55e',
    badge: 'Nano',
    kind: 'image',
  },
  {
    type: 'ai-text',
    label: '生成文本',
    icon: 'mdi:text-box-outline',
    iconColor: '#6366f1',
    badge: 'LLM',
    kind: 'text',
  },
  {
    type: 'ai-video',
    label: '生成视频',
    icon: 'mdi:video-outline',
    iconColor: '#3b82f6',
    badge: '1080P',
    kind: 'video',
  },
  {
    type: 'ai-storyboard',
    label: '宫格分镜',
    icon: 'mdi:grid',
    iconColor: '#ec4899',
    badge: '4格',
    kind: 'storyboard',
  },
  {
    type: 'ai-audio',
    label: '生成音频',
    icon: 'mdi:volume-high',
    iconColor: '#f97316',
    badge: 'MP3',
    kind: 'audio',
  },
];

function PresetSingleNodePreview({
  theme,
  index,
  realNodes,
}: {
  theme: AppearanceTheme;
  index: number;
  realNodes: Node<BaseNodeData>[];
}) {
  const themeResolved = resolveAppearanceTheme(theme);
  const isDark = themeResolved.mode === 'dark';
  const hasReal = realNodes.length > 0;
  const seed = getThemeNodeSeed(theme.id) + index;
  const pickedReal = hasReal ? realNodes[seed % realNodes.length] : null;

  let label: string;
  let icon: string;
  let iconColor: string;
  let displayId: number | undefined;
  let badgeText: string;
  let imageSrc: string | undefined;
  let videoThumb: string | undefined;
  let promptText = '';
  let kind: 'image' | 'text' | 'video' | 'audio' | 'storyboard';

  if (pickedReal) {
    const data = (pickedReal.data || {}) as BaseNodeData;
    const config = getNodeTypeConfig(pickedReal.type || 'ai-image');
    label = data.label || config.label || '节点';
    icon = config.icon || 'mdi:cube-outline';
    iconColor = themeResolved.ui.accent;
    displayId = data.displayId;
    badgeText = data.model ? data.model.split('/').pop() || 'AI' : (config.label || '节点');

    const rawOutput = data.output;
    const outputStr = typeof rawOutput === 'string' ? rawOutput : '';
    const rawImg = data.imageUrl || data.thumbnailUrl || (outputStr.startsWith('http') || outputStr.startsWith('data:') || outputStr.startsWith('asset:') ? outputStr : undefined);
    imageSrc = typeof rawImg === 'string' ? rawImg : undefined;

    const rawVideo = data.videoUrl || data.imageUrl || data.thumbnailUrl;
    videoThumb = typeof rawVideo === 'string' ? rawVideo : undefined;
    promptText = data.prompt || (!imageSrc && outputStr ? outputStr : '');

    const nodeType = pickedReal.type || '';
    if (nodeType.includes('image')) {
      kind = 'image';
    } else if (nodeType.includes('video')) {
      kind = 'video';
    } else if (nodeType.includes('audio')) {
      kind = 'audio';
    } else if (nodeType.includes('storyboard')) {
      kind = 'storyboard';
    } else {
      kind = 'text';
    }
  } else {
    const template = BLANK_NODE_TEMPLATES[seed % BLANK_NODE_TEMPLATES.length];
    label = template.label;
    icon = template.icon;
    iconColor = template.iconColor;
    badgeText = template.badge || '空白';
    kind = template.kind;
  }

  const innerRadius = Math.max(0, themeResolved.node.radius - 3);
  const innerBg = isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)';
  const innerBorder = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.08)';

  return (
    <div className="relative flex flex-col z-10 w-[214px] max-w-[94%] mx-auto shrink-0 select-none">
      {/* Node Header Label */}
      <div className="flex items-center justify-between mb-1 px-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="w-4 h-4 rounded flex items-center justify-center shrink-0"
            style={{ backgroundColor: `${themeResolved.ui.accent}20` }}
          >
            <Icon icon={icon} width="11" height="11" style={{ color: iconColor }} />
          </span>
          <span
            className="text-[10px] font-semibold truncate leading-none"
            style={{ color: themeResolved.ui.text }}
          >
            {label}
          </span>
          {displayId != null && (
            <span className="text-[9px] font-mono opacity-50 tabular-nums" style={{ color: themeResolved.ui.text }}>
              #{displayId}
            </span>
          )}
        </div>
        <span
          className="text-[8px] px-1.5 py-0.5 rounded font-medium shrink-0 leading-tight"
          style={{
            backgroundColor: `${themeResolved.ui.accent}18`,
            color: themeResolved.ui.accent,
          }}
        >
          {badgeText}
        </span>
      </div>

      {/* Node Card Shell */}
      <div
        className="relative p-2 shadow-xs transition-all flex flex-col justify-between"
        style={{
          backgroundColor: isTransparentColor(themeResolved.node.background)
            ? 'transparent'
            : themeResolved.node.background,
          borderColor: isTransparentColor(themeResolved.node.border)
            ? 'transparent'
            : themeResolved.node.border,
          borderWidth: `${Math.max(1, themeResolved.node.borderWidth)}px`,
          borderRadius: `${themeResolved.node.radius}px`,
          height: '62px',
        }}
      >
        {/* Left Input Port */}
        <span
          className="absolute -left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border border-white/80 shadow-xs flex items-center justify-center z-10"
          style={{ backgroundColor: themeResolved.handle.color }}
        >
          <span className="w-1 h-1 rounded-full bg-white/90" />
        </span>

        {/* Right Output Port */}
        <span
          className="absolute -right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border border-white/80 shadow-xs flex items-center justify-center z-10"
          style={{ backgroundColor: themeResolved.handle.color }}
        >
          <span className="w-1 h-1 rounded-full bg-white/90" />
        </span>

        {/* Inner Content */}
        {kind === 'image' && (
          imageSrc ? (
            <div
              className="w-full h-full relative overflow-hidden flex items-center justify-center"
              style={{
                borderRadius: `${innerRadius}px`,
                backgroundColor: innerBg,
                borderColor: innerBorder,
                borderWidth: '1px',
              }}
            >
              <img
                src={imageSrc}
                alt=""
                className="w-full h-full object-cover"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
              <span
                className="absolute bottom-1 right-1 text-[7px] font-mono px-1 py-0.2 rounded font-semibold leading-tight"
                style={{
                  backgroundColor: isDark ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.85)',
                  color: isDark ? '#ffffff' : '#1e293b',
                }}
              >
                IMG
              </span>
            </div>
          ) : (
            <div className="flex flex-col justify-between h-full space-y-1">
              <div
                className="px-2 py-0.5 text-[9px] flex items-center justify-between"
                style={{
                  borderRadius: `${Math.max(0, innerRadius - 2)}px`,
                  backgroundColor: innerBg,
                  borderColor: innerBorder,
                  borderWidth: '1px',
                  color: themeResolved.ui.text,
                }}
              >
                <span className="truncate opacity-75">{promptText || '输入提示词生成图像…'}</span>
                <span className="text-[8px] font-mono opacity-50 shrink-0 ml-1">1:1</span>
              </div>
              <div
                className="flex-1 w-full border border-dashed flex items-center justify-center gap-1.5 opacity-80"
                style={{
                  borderRadius: `${Math.max(0, innerRadius - 2)}px`,
                  backgroundColor: innerBg,
                  borderColor: innerBorder,
                  color: themeResolved.ui.text,
                }}
              >
                <Icon icon="mdi:image-outline" width="13" height="13" style={{ opacity: 0.6 }} />
                <span className="text-[8px] opacity-75">等待生成图像</span>
              </div>
            </div>
          )
        )}

        {kind === 'video' && (
          videoThumb ? (
            <div
              className="w-full h-full relative overflow-hidden flex items-center justify-center"
              style={{
                borderRadius: `${innerRadius}px`,
                backgroundColor: innerBg,
                borderColor: innerBorder,
                borderWidth: '1px',
              }}
            >
              <img
                src={videoThumb}
                alt=""
                className="w-full h-full object-cover"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
              <div className="absolute w-5 h-5 rounded-full bg-black/60 flex items-center justify-center text-white shadow-xs">
                <Icon icon="mdi:play" width="12" height="12" />
              </div>
            </div>
          ) : (
            <div className="flex flex-col justify-between h-full space-y-1">
              <div
                className="px-2 py-0.5 text-[9px] flex items-center justify-between"
                style={{
                  borderRadius: `${Math.max(0, innerRadius - 2)}px`,
                  backgroundColor: innerBg,
                  borderColor: innerBorder,
                  borderWidth: '1px',
                  color: themeResolved.ui.text,
                }}
              >
                <span className="truncate opacity-75">{promptText || '输入视频运镜描述…'}</span>
                <span className="text-[8px] font-mono opacity-50 shrink-0 ml-1">5s</span>
              </div>
              <div
                className="flex-1 w-full border border-dashed flex items-center justify-center gap-1.5 opacity-80"
                style={{
                  borderRadius: `${Math.max(0, innerRadius - 2)}px`,
                  backgroundColor: innerBg,
                  borderColor: innerBorder,
                  color: themeResolved.ui.text,
                }}
              >
                <Icon icon="mdi:video-outline" width="13" height="13" style={{ opacity: 0.6 }} />
                <span className="text-[8px] opacity-75">等待生成视频</span>
              </div>
            </div>
          )
        )}

        {kind === 'text' && (
          <div className="flex flex-col justify-between h-full space-y-1">
            <div
              className="px-2 py-0.5 text-[9px] flex items-center justify-between"
              style={{
                borderRadius: `${Math.max(0, innerRadius - 2)}px`,
                backgroundColor: innerBg,
                borderColor: innerBorder,
                borderWidth: '1px',
                color: themeResolved.ui.text,
              }}
            >
              <span className="truncate opacity-75">{promptText || '输入文本提示词…'}</span>
              <span className="text-[8px] font-mono opacity-50 shrink-0 ml-1">Text</span>
            </div>
            <div className="space-y-1 px-0.5 py-0.5">
              <div
                className="h-1.5 rounded-full"
                style={{ width: '85%', backgroundColor: themeResolved.ui.text, opacity: 0.45 }}
              />
              <div
                className="h-1.5 rounded-full"
                style={{ width: '60%', backgroundColor: themeResolved.ui.text, opacity: 0.25 }}
              />
            </div>
          </div>
        )}

        {kind === 'storyboard' && (
          <div className="grid grid-cols-4 gap-1 h-full w-full">
            {['#1', '#2', '#3', '#4'].map((idx) => (
              <div
                key={idx}
                className="flex flex-col items-center justify-center"
                style={{
                  borderRadius: `${Math.max(0, innerRadius - 2)}px`,
                  backgroundColor: innerBg,
                  borderColor: innerBorder,
                  borderWidth: '1px',
                  color: themeResolved.ui.text,
                }}
              >
                <Icon icon="mdi:plus" width="9" height="9" className="opacity-40" />
                <span className="text-[7px] font-mono opacity-60 leading-none mt-0.5">{idx}</span>
              </div>
            ))}
          </div>
        )}

        {kind === 'audio' && (
          <div
            className="h-full w-full flex items-center justify-between px-2.5"
            style={{
              borderRadius: `${innerRadius}px`,
              backgroundColor: innerBg,
              borderColor: innerBorder,
              borderWidth: '1px',
            }}
          >
            <div className="flex items-center gap-1.5 text-orange-400">
              <Icon icon="mdi:play-circle-outline" width="15" height="15" />
              <span className="text-[9px] font-mono">00:15</span>
            </div>
            <div className="flex items-center gap-0.5 h-5">
              <div className="w-1 h-2 rounded-full bg-orange-400/40" />
              <div className="w-1 h-3.5 rounded-full bg-orange-400/80" />
              <div className="w-1 h-5 rounded-full bg-orange-400" />
              <div className="w-1 h-3 rounded-full bg-orange-400/60" />
              <div className="w-1 h-4.5 rounded-full bg-orange-400" />
              <div className="w-1 h-3 rounded-full bg-orange-400/70" />
              <div className="w-1 h-1.5 rounded-full bg-orange-400/30" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function imagePreviewStyle(imageDataUrl: string | undefined, size: CSSProperties['backgroundSize'] = 'cover'): CSSProperties | undefined {
  return imageDataUrl
    ? { backgroundImage: `url(${imageDataUrl})`, backgroundPosition: 'center', backgroundSize: size === 'fill' ? '100% 100%' : size }
    : undefined;
}

function ColorCardInput({
  label,
  value,
  onChange,
  allowNone = true,
  fallbackColor = '#6366f1',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  allowNone?: boolean;
  fallbackColor?: string;
}) {
  const isNone = isTransparentColor(value);
  const safeHex = /^#[0-9a-f]{6}$/i.test(value) ? value : fallbackColor;

  return (
    <div className="p-3 settings-sub-card rounded-xl flex items-center justify-between transition-colors">
      <span className="text-xs font-semibold text-canvas-text">{label}</span>
      <div className="flex items-center space-x-1.5 settings-sub-card-inner px-2 py-1.5 rounded-lg shadow-2xs">
        <label
          className="relative w-6 h-5 rounded cursor-pointer block border border-black/10 shrink-0 overflow-hidden shadow-2xs"
          style={
            isNone
              ? {
                  background:
                    'linear-gradient(to top right, transparent calc(50% - 1px), #ef4444 calc(50% - 1px), #ef4444 calc(50% + 1px), transparent calc(50% + 1px)), #ffffff',
                }
              : { backgroundColor: safeHex }
          }
          title={isNone ? '无颜色（点击选择颜色）' : '点击选择颜色'}
        >
          <input
            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
            type="color"
            value={safeHex}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
        <input
          className={`w-16 text-xs font-medium bg-transparent border-none p-0 focus:ring-0 uppercase focus:outline-none ${
            isNone ? 'text-canvas-text-muted font-sans' : 'text-canvas-text font-mono'
          }`}
          type="text"
          value={isNone ? '无' : value}
          onChange={(e) => {
            const raw = e.target.value;
            if (isTransparentColor(raw) || raw.trim() === '') {
              onChange('transparent');
            } else if (/^#?[0-9a-f]{6}$/i.test(raw.trim())) {
              onChange(raw.trim().startsWith('#') ? raw.trim() : `#${raw.trim()}`);
            } else {
              onChange(raw);
            }
          }}
          placeholder={isNone ? '无' : '#HEX'}
          aria-label={`${label}颜色值`}
        />
        {allowNone && (
          <button
            type="button"
            onClick={() => onChange(isNone ? safeHex : 'transparent')}
            className={`text-[11px] px-1.5 py-0.5 rounded transition-all select-none ${
              isNone
                ? 'bg-brand/15 text-brand-light font-bold ring-1 ring-brand/30'
                : 'text-canvas-text-muted hover:text-canvas-text hover:bg-canvas-hover'
            }`}
            title={isNone ? '当前已为无，点击恢复颜色' : '设为无'}
          >
            无
          </button>
        )}
      </div>
    </div>
  );
}

function QuickSwatches({
  colors,
  value,
  onChange,
  title,
}: {
  colors: readonly string[];
  value: string;
  onChange: (val: string) => void;
  title?: string;
}) {
  return (
    <div className="flex items-center space-x-3 pt-1" aria-label={title}>
      {colors.map((color) => {
        const isSelected = value.toLowerCase() === color.toLowerCase();
        return (
          <button
            key={color}
            type="button"
            onClick={() => onChange(color)}
            style={{ backgroundColor: color }}
            className={`w-8 h-8 rounded-lg transition-transform ${
              isSelected
                ? 'ring-2 ring-brand ring-offset-2 ring-offset-canvas-card flex items-center justify-center text-white shadow-xs'
                : 'hover:scale-105'
            }`}
            title={color}
          >
            {isSelected && (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}

function SectionCard({
  title,
  description,
  icon,
  children,
  dataPurpose,
  className = '',
}: {
  title: string;
  description: string;
  icon: ReactNode;
  children: ReactNode;
  dataPurpose?: string;
  className?: string;
}) {
  return (
    <section
      className={`settings-section-card rounded-2xl p-3 shadow-xs transition-colors ${className}`}
      data-purpose={dataPurpose}
    >
      <div className="flex items-center space-x-3 mb-4">
        <div className="w-8 h-8 rounded-lg settings-section-icon-box flex items-center justify-center shrink-0">
          {icon}
        </div>
        <div>
          <h3 className="text-sm font-bold settings-section-title">{title}</h3>
          <p className="text-xs settings-section-desc">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 1024 1024" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M757.934 1024H205.213c-37.08 0-70.971-31.966-70.971-68.162V323.102l67.245-31.593h557.249l67.243 31.593v632.736c0 36.196-30.971 68.162-68.045 68.162zM196.95 330.778v625.06c0 1.968 3.714 5.577 9.774 5.577h546.681c6.06 0 9.773-3.615 9.773-5.577v-625.06H196.95z" />
      <path d="M885.083 331.135H75.482c-37.077 0-67.24-27.443-67.24-61.172v-66.397c0-33.723 30.163-61.161 67.24-61.161h809.601c37.079 0 67.243 27.438 67.243 61.161v66.397c0 33.729-30.164 61.172-67.243 61.172zM71.073 268.228h817.832v-63.324H71.073v63.324z" />
      <path d="M633.102 201.67H332.368c-37.083 0-71.877-27.443-71.877-61.172V77.607c0-33.723 34.794-61.161 71.877-61.161h300.734c37.08 0 67.244 27.438 67.244 61.161v62.891c0 33.729-92.972 61.172-67.244 61.172zM638.024 140.295V79.427H323.2v60.868h314.824z" />
      <path d="M322.84 457.025h62.985v377.63H322.84zM449.015 457.025H512v377.63h-62.985zM574.832 457.025h62.985v377.63h-62.985z" />
    </svg>
  );
}

export default function AppearanceSettings() {
  const t = useT();
  const config = useAppStore((state) => state.config);
  const themes = useAppStore((state) => state.appearanceThemes);
  const preview = useAppStore((state) => state.previewAppearanceTheme);
  const clearPreview = useAppStore((state) => state.clearAppearancePreview);
  const activate = useAppStore((state) => state.activateAppearanceTheme);
  const saveTheme = useAppStore((state) => state.saveAppearanceTheme);
  const duplicateTheme = useAppStore((state) => state.duplicateAppearanceTheme);
  const renameTheme = useAppStore((state) => state.renameAppearanceTheme);
  const deleteTheme = useAppStore((state) => state.deleteAppearanceTheme);
  const showToast = useAppStore((state) => state.showToast);
  const updateConfig = useAppStore((state) => state.updateConfig);
  const saveConfig = useAppStore((state) => state.saveConfig);
  const customCursor = config.customCursor !== false;
  const canvasNodes = useAppStore((state) => state.nodes ?? []);
  const realNodes = useMemo(
    () => canvasNodes.filter((n) => n.type && n.type !== 'comment' && n.type !== 'canvas-note' && n.type !== 'group'),
    [canvasNodes]
  );
  const [solarPlanetIndex] = useState(() => Math.floor(Math.random() * SOLAR_SYSTEM_PLANETS.length));

  const importRef = useRef<HTMLInputElement>(null);
  const canvasImageRef = useRef<HTMLInputElement>(null);
  const handleImageRef = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState<AppearanceTheme | null>(null);
  const draftRef = useRef<AppearanceTheme | null>(null);
  const pendingSaveRef = useRef<Promise<void> | null>(null);

  const [presetName, setPresetName] = useState('');
  const [isNamingPreset, setIsNamingPreset] = useState(false);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editingPresetName, setEditingPresetName] = useState('');
  const [confirmation, setConfirmation] = useState<{ kind: 'delete' | 'overwrite'; theme: AppearanceTheme } | null>(null);
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const persistedTheme = config.appearance
    ? normalizeAppearanceTheme(config.appearance)
    : themes.find((theme) => theme.id === config.theme)
    ?? themes[0];
  const savedActive = normalizeAppearanceTheme(persistedTheme);
  const active = draft ?? savedActive;
  const presetThemes = themes;
  const currentPreset = themes.find((theme) => theme.id === savedActive.id);

  useEffect(() => () => {
    if (useAppStore.getState().appearancePreview) clearPreview();
  }, [clearPreview]);

  const update = (patch: (theme: AppearanceTheme) => AppearanceTheme) => {
    const editable = structuredClone(draft ?? savedActive);
    const next = normalizeAppearanceTheme(patch(editable));
    draftRef.current = next;
    setDraft(next);
    setAutoSaveStatus('saving');
    preview(next);
  };

  const flushDraft = useCallback(async () => {
    while (true) {
      if (pendingSaveRef.current) {
        await pendingSaveRef.current;
        continue;
      }
      const pending = draftRef.current;
      if (!pending) return;
      const save = activate({ ...pending, updatedAt: Date.now() });
      pendingSaveRef.current = save;
      try {
        await save;
        if (draftRef.current === pending) {
          draftRef.current = null;
          setDraft(null);
          setAutoSaveStatus('saved');
        }
      } catch (error) {
        if (draftRef.current === pending) setAutoSaveStatus('error');
        throw error;
      } finally {
        if (pendingSaveRef.current === save) pendingSaveRef.current = null;
      }
    }
  }, [activate]);

  useEffect(() => registerSettingsProducer(flushDraft), [flushDraft]);

  useEffect(() => {
    if (!draft) return;
    const timer = window.setTimeout(() => {
      void flushDraft().catch(() => {});
    }, 500);
    return () => window.clearTimeout(timer);
  }, [draft, flushDraft]);

  if (!active) return null;

  const resolved = resolveAppearanceTheme(active);

  const canvasStyle = resolved.canvas.kind === 'color'
    ? { backgroundColor: resolved.canvas.color }
    : resolved.canvas.kind === 'image'
      ? imagePreviewStyle(resolved.canvas.imageDataUrl)
      : { backgroundColor: resolved.ui.background };

  const updateMode = async (mode: AppearanceTheme['mode']) => {
    const resolvedMode = resolveAppearanceMode(mode);
    const base = getBuiltinAppearanceTheme(`standard-${resolvedMode}`);
    draftRef.current = null;
    setDraft(null);
    setAutoSaveStatus('idle');
    await activate({ ...base, mode });
  };

  const importTheme = async (file: File) => {
    try {
      const theme = await importAppearanceTheme(file);
      await saveTheme(theme);
      draftRef.current = null;
      setDraft(null);
      setAutoSaveStatus('idle');
      showToast(t('主题已导入'), 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('主题导入失败'), 'error');
    }
  };

  const exportTheme = async () => {
    const fileName = `${active.name || 'ai-canvas-theme'}.aicanvas-theme`;
    const blob = exportAppearanceTheme(active);
    try {
      if (isTauriEnv()) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const savedPath = await saveBinaryToLocalFile(bytes, fileName, [
          { name: 'AI Canvas 主题', extensions: ['aicanvas-theme'] },
          { name: 'JSON 文件', extensions: ['json'] },
        ]);
        if (savedPath) showToast(t('主题已导出'), 'success');
        return;
      }

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(t('主题已导出'), 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('主题导出失败'), 'error');
    }
  };

  const setCanvasImage = async (file: File) => {
    const imageDataUrl = await readFileAsDataUrl(file);
    update((theme) => ({ ...theme, canvas: { ...theme.canvas, kind: 'image', imageDataUrl } }));
  };

  const setHandleImage = async (file: File) => {
    const imageDataUrl = await readFileAsDataUrl(file);
    update((theme) => ({ ...theme, handle: { ...theme.handle, kind: 'image', imageDataUrl } }));
  };

  const savePreset = async () => {
    const name = presetName.trim();
    if (!name) {
      showToast(t('请输入预设名称'), 'info');
      return;
    }
    try {
      await duplicateTheme(active, name);
      setPresetName('');
      setIsNamingPreset(false);
      draftRef.current = null;
      setDraft(null);
      showToast(t('预设已保存'), 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('预设保存失败'), 'error');
    }
  };

  const renamePreset = async (theme: AppearanceTheme) => {
    if (editingPresetId !== theme.id) return;
    const name = editingPresetName.trim();
    setEditingPresetId(null);
    if (!name || name === theme.name || theme.builtin) return;
    try {
      await renameTheme(theme.id, name);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('预设重命名失败'), 'error');
    }
  };

  const confirmPresetAction = async () => {
    const pending = confirmation;
    if (!pending) return;
    setConfirmation(null);
    try {
      if (pending.kind === 'delete') {
        if (pending.theme.id === savedActive.id) {
          draftRef.current = null;
          setDraft(null);
        }
        await deleteTheme(pending.theme.id);
        setAutoSaveStatus('saved');
        return;
      }
      await saveTheme({
        ...active,
        id: pending.theme.id,
        name: pending.theme.name,
        builtin: false,
        updatedAt: Date.now(),
      });
      draftRef.current = null;
      setDraft(null);
      setAutoSaveStatus('saved');
      showToast(t('当前预设已覆盖'), 'success');
    } catch (error) {
      setAutoSaveStatus('error');
      showToast(error instanceof Error ? error.message : t('预设操作失败'), 'error');
    }
  };

  return (
    <main className="flex-1 overflow-y-auto px-6 sm:px-6 py-6 space-y-6 settings-appearance-view" data-purpose="appearance-settings-view">
      {/* Top Header & Primary Action Bar */}
      <div className="space-y-4 pb-2">
        <div className="flex items-start justify-between">
          <div className="flex items-center space-x-3.5">
            <div className="w-12 h-12 rounded-2xl settings-header-icon-box flex items-center justify-center shadow-xs">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24">
                <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
              </svg>
            </div>
            <div>
              <div className="flex items-center space-x-2.5">
                <h2 className="text-xl font-bold text-canvas-text tracking-tight">{t('外观')}</h2>
                <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold settings-theme-pill">
                  {active.mode === 'dark' ? t('深色') : active.mode === 'light' ? t('浅色') : t('跟随系统')}
                </span>
              </div>
              <p className="text-xs text-canvas-text-muted mt-1">{t('外观预设包含画布、节点、连接线、连接手柄和所有页面配色')}</p>
            </div>
          </div>

          {/* Auto-save state indicator */}
          <div className="flex items-center space-x-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20">
            <span className={`w-1.5 h-1.5 rounded-full ${autoSaveStatus === 'saving' ? 'animate-pulse bg-brand' : autoSaveStatus === 'error' ? 'bg-danger' : 'bg-emerald-500'}`} />
            <span>
              {autoSaveStatus === 'saving' ? t('正在自动保存…') : autoSaveStatus === 'saved' ? t('已自动保存') : autoSaveStatus === 'error' ? t('自动保存失败') : t('自动保存')}
            </span>
          </div>
        </div>

        {/* Action buttons group */}
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={() => importRef.current?.click()}
              className="inline-flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium rounded-lg settings-action-btn transition-all shadow-xs"
            >
              <svg className="w-3.5 h-3.5 text-canvas-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
              <span>{t('导入')}</span>
            </button>
            <button
              type="button"
              onClick={() => void exportTheme()}
              className="inline-flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium rounded-lg settings-action-btn transition-all shadow-xs"
            >
              <svg className="w-3.5 h-3.5 text-canvas-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
              <span>{t('导出')}</span>
            </button>

            {isNamingPreset ? (
              <div className="flex items-center space-x-1.5">
                <input
                  autoFocus
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void savePreset();
                    if (e.key === 'Escape') {
                      setPresetName('');
                      setIsNamingPreset(false);
                    }
                  }}
                  placeholder={t('输入预设名称')}
                  className="px-2.5 py-1 text-xs bg-canvas-surface border border-brand rounded-lg text-canvas-text focus:outline-none w-36"
                />
                <button
                  type="button"
                  onClick={() => void savePreset()}
                  className="px-2.5 py-1 text-xs font-medium text-white bg-brand rounded-lg hover:opacity-90"
                >
                  {t('确定')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPresetName('');
                    setIsNamingPreset(false);
                  }}
                  className="px-2.5 py-1 text-xs font-medium text-canvas-text-muted hover:text-canvas-text"
                >
                  {t('取消')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIsNamingPreset(true)}
                className="inline-flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium rounded-lg settings-action-btn transition-all shadow-xs"
              >
                <svg className="w-3.5 h-3.5 text-canvas-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                </svg>
                <span>{t('保存预设')}</span>
              </button>
            )}
            <input
              ref={importRef}
              type="file"
              accept=".aicanvas-theme,.json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importTheme(file);
                e.currentTarget.value = '';
              }}
            />
          </div>

          <button
            type="button"
            disabled={!currentPreset || currentPreset.builtin}
            title={currentPreset?.builtin ? t('内置预设不可覆盖') : t('覆盖当前预设')}
            onClick={() => {
              if (currentPreset && !currentPreset.builtin) {
                setConfirmation({ kind: 'overwrite', theme: currentPreset });
              }
            }}
            className="inline-flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium rounded-lg settings-overwrite-btn disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <svg className="w-3.5 h-3.5 text-canvas-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
            <span>{t('覆盖当前预设')}</span>
          </button>
        </div>
      </div>

      {/* BEGIN: LiveCanvasPreviewCard */}
      <section className="relative settings-preview-card rounded-2xl p-4 overflow-hidden shadow-xs" data-purpose="interactive-live-preview" style={canvasStyle}>
        {resolved.canvas.kind === 'solar-system' && (
          <>
            <div className="solar-stars opacity-75 pointer-events-none" />
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none overflow-hidden" style={{ bottom: '-55%' }}>
              <img
                src={SOLAR_SYSTEM_PLANETS[solarPlanetIndex].image}
                alt={SOLAR_SYSTEM_PLANETS[solarPlanetIndex].name}
                className="w-72 h-72 object-contain rounded-full opacity-35 filter brightness-95 pointer-events-none select-none"
              />
            </div>
          </>
        )}
        {/* Dot Grid Backdrop */}
        <div
          className={`absolute inset-0 ${active.mode === 'dark' ? 'bg-dot-pattern-dark' : 'bg-dot-pattern'} ${resolved.canvas.kind === 'solar-system' ? 'opacity-25' : 'opacity-60'}`}
          style={
            resolved.canvas.gridColor && !isTransparentColor(resolved.canvas.gridColor)
              ? { backgroundImage: `radial-gradient(${resolved.canvas.gridColor} 1px, transparent 1px)` }
              : (isTransparentColor(resolved.canvas.gridColor) ? { backgroundImage: 'none' } : undefined)
          }
        />
        <div className="relative flex items-center justify-between min-h-[96px] px-4">
          {/* Left: Node representation with input socket */}
          <div
            className="w-48 settings-preview-node rounded-xl p-3 shadow-md backdrop-blur transition-all"
            style={{
              backgroundColor: isTransparentColor(resolved.node.background) ? 'transparent' : resolved.node.background,
              borderColor: isTransparentColor(resolved.node.border) ? 'transparent' : resolved.node.border,
              borderWidth: `${resolved.node.borderWidth}px`,
              borderRadius: `${resolved.node.radius}px`,
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold text-canvas-text">{t('节点预览')}</span>
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
            </div>
            {/* 内部输入框：跟随节点圆角 */}
            <div
              className="px-2.5 py-1.5 text-[10px] bg-canvas-card border border-canvas-border text-canvas-text-muted flex items-center justify-between transition-all"
              style={{
                borderRadius: `${Math.max(0, resolved.node.radius - 4)}px`,
              }}
            >
              <span className="truncate">{t('输入提示词…')}</span>
              <span className="text-[9px] opacity-40 font-mono shrink-0 ml-1">12字</span>
            </div>
            {/* 内部图片/媒体预览：跟随节点圆角 */}
            <div
              className="mt-2 h-12 w-full bg-canvas-card border border-canvas-border overflow-hidden relative flex items-center justify-center transition-all"
              style={{
                borderRadius: `${Math.max(0, resolved.node.radius - 3)}px`,
              }}
            >
              <div className="absolute inset-0 bg-gradient-to-tr from-brand-500/20 via-transparent to-purple-500/15" />
              <svg className="w-4 h-4 text-canvas-text-muted opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <rect width="18" height="18" x="3" y="3" rx="2" strokeWidth="1.5" />
                <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" />
                <path d="M21 15l-5-5L5 21" strokeWidth="1.5" />
              </svg>
              <span className="absolute bottom-1 right-1.5 text-[8px] px-1 py-0.2 rounded bg-black/50 text-white/80 font-mono">IMG / MP4</span>
            </div>
          </div>

          {/* Center: Spline wire flow preview */}
          <div className="flex-1 mx-4 h-12 relative flex items-center justify-center">
            <svg className="w-full h-12 overflow-visible" preserveAspectRatio="none" viewBox="0 0 300 40">
              <defs>
                <linearGradient id="liveSplineGradient" x1="0%" x2="100%" y1="0%" y2="0%">
                  <stop offset="0%" stopColor={resolved.edge.color} />
                  <stop offset="50%" stopColor={resolved.edge.flowColor || resolved.ui.accent} />
                  <stop offset="100%" stopColor={resolved.edge.color} />
                </linearGradient>
              </defs>
              {/* Background wire shadow */}
              <path
                d="M 0,20 C 120,20 180,20 300,20"
                fill="none"
                stroke={resolved.edge.color}
                strokeOpacity="0.25"
                strokeLinecap="round"
                strokeWidth="7"
              />
              {/* Active glowing spline wire */}
              <path
                d="M 0,20 C 120,20 180,20 300,20"
                fill="none"
                stroke="url(#liveSplineGradient)"
                strokeLinecap="round"
                strokeWidth="4.5"
              />
              {/* Animated flow particle highlight */}
              {resolved.edge.animationEnabled && (
                <path
                  className="animate-flow-dash"
                  d="M 0,20 C 120,20 180,20 300,20"
                  fill="none"
                  stroke="#ffffff"
                  strokeLinecap="round"
                  strokeWidth="2"
                  opacity="0.9"
                />
              )}
            </svg>
          </div>

          {/* Right: Interactive Port / Socket preview with pulse effect */}
          <div className="relative flex items-center pl-2">
            <div className="relative flex items-center justify-center">
              <span
                className="absolute w-8 h-8 rounded-full animate-pulse-subtle"
                style={{ backgroundColor: resolved.handle.color, opacity: 0.25 }}
              />
              <span
                className="w-6 h-6 rounded-full border-2 border-white shadow-md flex items-center justify-center overflow-hidden bg-cover bg-center"
                style={
                  resolved.handle.kind === 'image' && resolved.handle.imageDataUrl
                    ? imagePreviewStyle(resolved.handle.imageDataUrl, resolved.handle.imageFit)
                    : { backgroundColor: resolved.handle.color, borderColor: '#ffffff' }
                }
              >
                {resolved.handle.kind !== 'image' && <span className="w-2 h-2 rounded-full bg-white" />}
              </span>
            </div>
            <div className="ml-4 text-right">
              <div className="text-[11px] font-medium text-canvas-text-muted">{t('当前主题')}</div>
              <div className="text-sm font-bold text-canvas-text">
                {active.mode === 'dark' ? t('深色') : active.mode === 'light' ? t('浅色') : t('跟随系统')}
              </div>
            </div>
          </div>
        </div>
      </section>
      {/* END: LiveCanvasPreviewCard */}

      <div className="h-px settings-h-divider my-2" />

      {/* BEGIN: PresetsSection */}
      <SectionCard
        title={t('外观预设')}
        description={t('选择、保存或管理完整外观配置')}
        icon={
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
            <line x1="12" x2="12" y1="22.08" y2="12" />
          </svg>
        }
        dataPurpose="theme-presets-picker"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {presetThemes.map((theme, index) => {
            const isCurrent = theme.id === active.id;
            const themeResolved = resolveAppearanceTheme(theme);
            const isDark = themeResolved.mode === 'dark';
            const isSolarSystem = themeResolved.canvas.kind === 'solar-system';
            const solarPlanet = isSolarSystem ? SOLAR_SYSTEM_PLANETS[(solarPlanetIndex + index) % SOLAR_SYSTEM_PLANETS.length] : null;

            return (
              <div
                key={theme.id}
                className={`group relative rounded-2xl overflow-hidden transition-all cursor-pointer border select-none ${
                  isCurrent ? 'settings-preset-card--active ring-2 ring-brand/35 shadow-md shadow-brand/10' : 'settings-preset-card hover:shadow-sm'
                }`}
                style={{
                  height: '136px',
                  background:
                    isSolarSystem
                      ? '#000000'
                      : themeResolved.canvas.kind === 'frosted-glass'
                        ? 'radial-gradient(ellipse at 80% 20%, rgba(245, 158, 11, 0.12) 0%, transparent 60%), radial-gradient(ellipse at 20% 80%, rgba(234, 88, 12, 0.08) 0%, transparent 50%), #f8f6f0'
                        : themeResolved.canvas.kind === 'color'
                          ? themeResolved.canvas.color
                          : themeResolved.ui.background,
                }}
              >
                <button
                  type="button"
                  aria-label={`${t('外观预设')}：${theme.name}`}
                  aria-pressed={isCurrent}
                  className="absolute inset-0 z-20 rounded-2xl border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                  onClick={() => {
                    draftRef.current = null;
                    setDraft(null);
                    setAutoSaveStatus('idle');
                    void activate(theme);
                  }}
                />
                {/* Solar system background elements */}
                {isSolarSystem && solarPlanet && (
                  <>
                    <div className="solar-stars opacity-80 pointer-events-none" />
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none overflow-hidden" style={{ bottom: '-40%' }}>
                      <img
                        src={solarPlanet.image}
                        alt={solarPlanet.name}
                        className="w-[180px] h-[180px] object-contain rounded-full opacity-40 filter brightness-95 pointer-events-none select-none"
                      />
                    </div>
                  </>
                )}

                {/* Dot Grid Backdrop across full card */}
                <div className={`absolute inset-0 ${isDark ? 'bg-dot-pattern-dark' : 'bg-dot-pattern-dense'} ${isSolarSystem ? 'opacity-20' : 'opacity-40'} pointer-events-none`} />

                {/* Node Preview Area */}
                <div className="w-full h-full flex items-center justify-center pt-2 pb-6 relative z-10">
                  <PresetSingleNodePreview theme={theme} index={index} realNodes={realNodes} />
                </div>

                {/* Floating Bottom Footer */}
                <div
                  className={`absolute bottom-0 inset-x-0 px-3 py-1.5 flex items-center justify-between z-30 pointer-events-none transition-colors ${
                    isDark
                      ? 'bg-gradient-to-t from-black/80 via-black/40 to-transparent text-white'
                      : 'bg-gradient-to-t from-white/90 via-white/50 to-transparent text-slate-800'
                  }`}
                >
                  <div className={`flex items-center gap-1.5 min-w-0 ${!theme.builtin ? 'pointer-events-auto' : ''}`}>
                    {editingPresetId === theme.id ? (
                      <input
                        autoFocus
                        value={editingPresetName}
                        onChange={(e) => setEditingPresetName(e.target.value)}
                        onBlur={() => void renamePreset(theme)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void renamePreset(theme);
                          if (e.key === 'Escape') setEditingPresetId(null);
                        }}
                        className="px-2 py-0.5 text-xs bg-canvas-surface border border-brand rounded text-canvas-text focus:outline-none w-28"
                        aria-label={t('预设名称')}
                      />
                    ) : theme.builtin ? (
                      <span className="text-xs font-semibold drop-shadow-xs flex items-center gap-1.5">
                        {theme.name}
                        {isCurrent && <span className="w-1.5 h-1.5 rounded-full bg-brand shadow-xs" />}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="group/name flex items-center gap-1 text-left text-xs font-semibold drop-shadow-xs hover:text-brand transition-colors"
                        title={t('重命名')}
                        onClick={() => {
                          setEditingPresetId(theme.id);
                          setEditingPresetName(theme.name);
                        }}
                      >
                        <span>{theme.name}</span>
                        {isCurrent && <span className="w-1.5 h-1.5 rounded-full bg-brand shadow-xs" />}
                        <Icon icon="lucide:pencil" width="11" height="11" className="opacity-0 group-hover/name:opacity-100 text-canvas-text-muted" />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center space-x-1.5 shrink-0">
                    {isCurrent && (
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-brand text-white shadow-xs">
                        {t('当前使用')}
                      </span>
                    )}
                    {!theme.builtin && (
                      <button
                        type="button"
                        onClick={() => setConfirmation({ kind: 'delete', theme })}
                        className="pointer-events-auto p-1 text-canvas-text-muted hover:text-danger rounded transition-colors"
                        title={t('删除预设')}
                        aria-label={t('删除预设')}
                      >
                        <TrashIcon />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </SectionCard>
      {/* END: PresetsSection */}

      {/* BEGIN: ThemeModeSegmentedControl */}
      <SectionCard
        title={t('主题模式')}
        description={t('选择整套界面的明暗基调')}
        icon={
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
          </svg>
        }
        dataPurpose="theme-mode-selection"
      >
        <div className="grid grid-cols-3 gap-2.5">
          {/* 1. 深色 */}
          <button
            type="button"
            onClick={() => void updateMode('dark')}
            className={`flex items-center justify-center space-x-2 py-2.5 px-4 rounded-xl text-xs font-semibold transition-all ${
              active.mode === 'dark' ? 'settings-mode-btn--active' : 'settings-mode-btn'
            }`}
          >
            <svg className="w-4 h-4 text-canvas-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
            <span>{t('深色')}</span>
          </button>

          {/* 2. 浅色 */}
          <button
            type="button"
            onClick={() => void updateMode('light')}
            className={`flex items-center justify-center space-x-2 py-2.5 px-4 rounded-xl text-xs font-semibold transition-all ${
              active.mode === 'light' ? 'settings-mode-btn--active' : 'settings-mode-btn'
            }`}
          >
            <svg className="w-4 h-4 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
            <span>{t('浅色')}</span>
          </button>

          {/* 3. 跟随系统 */}
          <button
            type="button"
            onClick={() => void updateMode('system')}
            className={`flex items-center justify-center space-x-2 py-2.5 px-4 rounded-xl text-xs font-semibold transition-all ${
              active.mode === 'system' ? 'settings-mode-btn--active' : 'settings-mode-btn'
            }`}
          >
            <svg className="w-4 h-4 text-canvas-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
            <span>{t('跟随系统')}</span>
          </button>
        </div>
      </SectionCard>
      {/* END: ThemeModeSegmentedControl */}

      {/* BEGIN: AccentColorSection */}
      <SectionCard
        title={t('主题色')}
        description={t('统一按钮和选中态强调色')}
        icon={
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d="M7 21a4 4 0 01-4-4 4 4 0 014-4h4a4 4 0 014 4 4 4 0 01-4 4H7zm0 0l4-4m-4 4a4 4 0 00-4-4V7a4 4 0 014-4h8a4 4 0 014 4v2" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
          </svg>
        }
        dataPurpose="theme-accent-color"
      >
        <div className="space-y-3.5">
          <ColorCardInput
            label={t('主题色')}
            value={active.ui.accent}
            fallbackColor={active.mode === 'light' ? '#7280E4' : '#6366f1'}
            onChange={(value) =>
              update((theme) => ({
                ...theme,
                ui: { ...theme.ui, accent: value, accentStrong: value, accentSoft: value, focus: value },
              }))
            }
          />
          <QuickSwatches
            colors={active.mode === 'light' ? LIGHT_THEME_COLOR_SWATCHES : DARK_THEME_COLOR_SWATCHES}
            value={active.ui.accent}
            onChange={(value) =>
              update((theme) => ({
                ...theme,
                ui: { ...theme.ui, accent: value, accentStrong: value, accentSoft: value, focus: value },
              }))
            }
            title={t('主题色调色板')}
          />
        </div>
      </SectionCard>
      {/* END: AccentColorSection */}

      {/* BEGIN: SurfaceHierarchySection */}
      <SectionCard
        title={t('界面底色')}
        description={t('分别配置页面、窗口和组件各层底色')}
        icon={
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
          </svg>
        }
        dataPurpose="surface-background-colors"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <ColorCardInput
            label={t('页面背景')}
            value={active.ui.background}
            fallbackColor={active.mode === 'light' ? '#F4F6FB' : '#0a0a0f'}
            onChange={(value) => update((theme) => ({ ...theme, ui: { ...theme.ui, background: value } }))}
          />
          <ColorCardInput
            label={t('窗口背景')}
            value={active.ui.surface}
            fallbackColor={active.mode === 'light' ? '#FFFFFF' : '#14141c'}
            onChange={(value) => update((theme) => ({ ...theme, ui: { ...theme.ui, surface: value } }))}
          />
          <ColorCardInput
            label={t('组件底色')}
            value={active.ui.card}
            fallbackColor={active.mode === 'light' ? '#F8FAFD' : '#1a1a26'}
            onChange={(value) => update((theme) => ({ ...theme, ui: { ...theme.ui, card: value } }))}
          />
          <ColorCardInput
            label={t('组件悬浮底色')}
            value={active.ui.hover}
            fallbackColor={active.mode === 'light' ? '#EEF1F8' : '#252535'}
            onChange={(value) => update((theme) => ({ ...theme, ui: { ...theme.ui, hover: value } }))}
          />
          <ColorCardInput
            label={t('组件边框')}
            value={active.ui.border}
            fallbackColor={active.mode === 'light' ? '#E4E8F2' : '#2a2a3a'}
            onChange={(value) => update((theme) => ({ ...theme, ui: { ...theme.ui, border: value } }))}
          />
        </div>
      </SectionCard>
      {/* END: SurfaceHierarchySection */}

      {/* BEGIN: SplineConnectionLinesSection */}
      <SectionCard
        title={t('连接线')}
        description={t('普通连线、流光与拖拽预览')}
        icon={
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <circle cx="6" cy="19" r="3" />
            <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
            <circle cx="18" cy="5" r="3" />
          </svg>
        }
        dataPurpose="connecting-lines-styling"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <ColorCardInput
            label={t('连接线颜色')}
            value={active.edge.color}
            fallbackColor={active.mode === 'light' ? '#B1B1B7' : '#33334a'}
            onChange={(value) => update((theme) => ({ ...theme, edge: { ...theme.edge, color: value } }))}
          />
          <ColorCardInput
            label={t('高亮动画颜色')}
            value={active.edge.flowColor}
            fallbackColor={active.mode === 'light' ? '#5A69D4' : '#818cf8'}
            onChange={(value) => update((theme) => ({ ...theme, edge: { ...theme.edge, flowColor: value } }))}
          />
          <ColorCardInput
            label={t('拖拽时连线颜色')}
            value={active.edge.previewColor}
            fallbackColor={active.mode === 'light' ? '#7280E4' : '#6366f1'}
            onChange={(value) => update((theme) => ({ ...theme, edge: { ...theme.edge, previewColor: value } }))}
          />
          <div className="p-3 settings-sub-card rounded-xl flex items-center justify-between">
            <label className="text-xs font-semibold text-canvas-text cursor-pointer select-none" htmlFor="enableGlowCheckbox">
              {t('启用高亮动画')}
            </label>
            <input
              id="enableGlowCheckbox"
              type="checkbox"
              checked={active.edge.animationEnabled}
              onChange={(e) => update((theme) => ({ ...theme, edge: { ...theme.edge, animationEnabled: e.target.checked } }))}
              className="w-4 h-4 text-brand rounded border-canvas-border focus:ring-brand cursor-pointer"
            />
          </div>
        </div>
      </SectionCard>
      {/* END: SplineConnectionLinesSection */}

      {/* BEGIN: ConnectionPortsSection */}
      <SectionCard
        title={t('连接手柄')}
        description={t('设置节点连接入口的颜色或图片样式')}
        icon={
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <polygon points="3 11 22 2 13 21 11 13 3 11" />
          </svg>
        }
        dataPurpose="connection-handles-settings"
        className="mb-4"
      >
        <div className="space-y-4">
          {/* Port Type Selector */}
          <div className="p-3 settings-sub-card rounded-xl flex items-center justify-between">
            <span className="text-xs font-semibold text-canvas-text">{t('手柄类型')}</span>
            <Select
              fixedMenu
              size="sm"
              value={active.handle.kind}
              onChange={(val) =>
                update((theme) => ({
                  ...theme,
                  handle: { ...theme.handle, kind: val as AppearanceTheme['handle']['kind'] },
                }))
              }
            >
              <option value="color">{t('纯色')}</option>
              <option value="image">{t('图片')}</option>
            </Select>
          </div>

          {/* Color Mode Settings */}
          {active.handle.kind === 'color' && (
            <div className="p-4 settings-sub-card rounded-xl space-y-4">
              <div className="flex items-center justify-between pb-1 border-b settings-h-divider">
                <span className="text-xs font-bold text-canvas-text">{t('颜色设置')}</span>
                <span className="text-[11px] text-canvas-text-muted">{t('普通状态与悬浮状态')}</span>
              </div>

              {/* Normal Handle Color */}
              <div className="space-y-2">
                <ColorCardInput
                  label={t('手柄颜色')}
                  value={active.handle.color}
                  fallbackColor={active.mode === 'light' ? '#7280E4' : '#6366f1'}
                  onChange={(val) => update((theme) => ({ ...theme, handle: { ...theme.handle, color: val } }))}
                />
                <QuickSwatches
                  colors={active.mode === 'light' ? LIGHT_THEME_COLOR_SWATCHES : DARK_THEME_COLOR_SWATCHES}
                  value={active.handle.color}
                  onChange={(val) => update((theme) => ({ ...theme, handle: { ...theme.handle, color: val } }))}
                />
              </div>

              {/* Hover Handle Color */}
              <div className="space-y-2 pt-1">
                <ColorCardInput
                  label={t('悬浮颜色')}
                  value={active.handle.hoverColor}
                  fallbackColor={active.mode === 'light' ? '#5A69D4' : '#818cf8'}
                  onChange={(val) => update((theme) => ({ ...theme, handle: { ...theme.handle, hoverColor: val } }))}
                />
                <QuickSwatches
                  colors={active.mode === 'light' ? LIGHT_THEME_COLOR_SWATCHES : DARK_THEME_COLOR_SWATCHES}
                  value={active.handle.hoverColor}
                  onChange={(val) => update((theme) => ({ ...theme, handle: { ...theme.handle, hoverColor: val } }))}
                />
              </div>
            </div>
          )}

          {/* Image Mode Settings */}
          {active.handle.kind === 'image' && (
            <div className="p-4 settings-sub-card rounded-xl space-y-3">
              <div className="flex items-center space-x-3">
                <div
                  className="h-16 w-16 shrink-0 overflow-hidden rounded-full border border-canvas-border bg-canvas-surface bg-center bg-no-repeat shadow-xs"
                  style={imagePreviewStyle(active.handle.imageDataUrl, active.handle.imageFit)}
                >
                  {!active.handle.imageDataUrl && (
                    <span className="flex h-full items-center justify-center px-1 text-center text-[9px] text-canvas-text-muted">
                      {t('未上传')}
                    </span>
                  )}
                </div>
                <div className="flex-1 space-y-1.5">
                  <div className="flex items-center space-x-2">
                    <button
                      type="button"
                      onClick={() => handleImageRef.current?.click()}
                      className="px-3 py-1.5 text-xs font-medium bg-canvas-surface border border-canvas-border rounded-lg text-canvas-text hover:bg-canvas-hover"
                    >
                      {t('选择手柄图片')}
                    </button>
                    {active.handle.imageDataUrl && (
                      <button
                        type="button"
                        onClick={() => update((theme) => ({ ...theme, handle: { ...theme.handle, imageDataUrl: undefined } }))}
                        className="px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 rounded-lg"
                      >
                        {t('移除图片')}
                      </button>
                    )}
                    <input
                      ref={handleImageRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void setHandleImage(file);
                        e.currentTarget.value = '';
                      }}
                    />
                  </div>
                  <p className="text-[11px] text-canvas-text-muted">{t('上传图片后会立即应用到节点连接手柄')}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                <div className="flex items-center justify-between p-2.5 bg-canvas-surface rounded-lg border border-canvas-border">
                  <span className="text-xs text-canvas-text-secondary">{t('图片适配')}</span>
                  <Select
                    fixedMenu
                    size="sm"
                    value={active.handle.imageFit}
                    onChange={(val) =>
                      update((theme) => ({
                        ...theme,
                        handle: { ...theme.handle, imageFit: val as AppearanceTheme['handle']['imageFit'] },
                      }))
                    }
                  >
                    <option value="contain">{t('完整显示')}</option>
                    <option value="cover">{t('铺满')}</option>
                    <option value="fill">{t('拉伸')}</option>
                  </Select>
                </div>

                <div className="flex items-center justify-between p-2.5 bg-canvas-surface rounded-lg border border-canvas-border">
                  <span className="text-xs text-canvas-text-secondary">{t('不透明度')}</span>
                  <div className="flex items-center space-x-2">
                    <input
                      type="range"
                      min="0.2"
                      max="1"
                      step="0.05"
                      value={active.handle.opacity}
                      onChange={(e) => update((theme) => ({ ...theme, handle: { ...theme.handle, opacity: Number(e.target.value) } }))}
                      className="w-24 accent-brand cursor-pointer"
                    />
                    <span className="text-xs text-canvas-text font-mono w-9 text-right">
                      {Math.round(active.handle.opacity * 100)}%
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Handle Size Slider */}
          <div className="p-4 settings-sub-card rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-canvas-text">{t('手柄尺寸')}</span>
              <NumberStepper
                id="portSizeInput"
                value={active.handle.size}
                min={16}
                max={64}
                step={1}
                unit="px"
                size="sm"
                onChange={(size) =>
                  update((theme) => ({
                    ...theme,
                    handle: { ...theme.handle, size },
                  }))
                }
              />
            </div>
            <input
              className="w-full h-1.5 bg-canvas-border rounded-lg appearance-none cursor-pointer accent-brand"
              id="portSizeSlider"
              max={64}
              min={16}
              type="range"
              value={active.handle.size}
              onChange={(e) => update((theme) => ({ ...theme, handle: { ...theme.handle, size: Number(e.target.value) } }))}
            />
          </div>
        </div>
      </SectionCard>
      {/* END: ConnectionPortsSection */}

      {/* BEGIN: Canvas & Node Appearance Section */}
      <SectionCard
        title={t('画布与节点外观')}
        description={t('配置画布背景纹理与节点通用样式')}
        icon={
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M3 9h18M9 21V9" />
          </svg>
        }
        dataPurpose="canvas-and-nodes-styling"
      >
        <div className="space-y-4">
          {/* Canvas Background Settings */}
          <div className="p-4 settings-sub-card rounded-xl space-y-3">
            <div className="flex items-center justify-between pb-1 border-b settings-h-divider">
              <span className="text-xs font-bold text-canvas-text">{t('画布背景')}</span>
              <span className="text-[11px] text-canvas-text-muted">{t('背景类型与网格')}</span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-canvas-text-secondary">{t('背景类型')}</span>
              <Select
                fixedMenu
                size="sm"
                value={active.canvas.kind}
                onChange={(val) =>
                  update((theme) => ({
                    ...theme,
                    canvas: { ...theme.canvas, kind: val as AppearanceTheme['canvas']['kind'] },
                  }))
                }
              >
                <option value="color">{t('纯色')}</option>
                <option value="image">{t('图片')}</option>
                <option value="solar-system">{t('太阳系')}</option>
                <option value="frosted-glass">{t('磨砂暖光')}</option>
              </Select>
            </div>

            {active.canvas.kind === 'color' && (
              <div className="space-y-2">
                <ColorCardInput
                  label={t('画布背景颜色')}
                  value={active.canvas.color}
                  fallbackColor={active.mode === 'light' ? '#F4F6FB' : '#0a0a0f'}
                  onChange={(value) => update((theme) => ({ ...theme, canvas: { ...theme.canvas, color: value, kind: 'color' } }))}
                />
                <QuickSwatches
                  colors={active.mode === 'light' ? LIGHT_CANVAS_COLOR_SWATCHES : DARK_CANVAS_COLOR_SWATCHES}
                  value={active.canvas.color}
                  onChange={(value) => update((theme) => ({ ...theme, canvas: { ...theme.canvas, color: value, kind: 'color' } }))}
                  title={t('画布底色预设')}
                />
              </div>
            )}

            {active.canvas.kind === 'image' && (
              <div className="flex items-center space-x-3 p-3 settings-sub-card rounded-lg">
                <div
                  className="h-14 w-20 shrink-0 overflow-hidden rounded-md border border-canvas-border bg-canvas-card bg-cover bg-center"
                  style={imagePreviewStyle(active.canvas.imageDataUrl)}
                >
                  {!active.canvas.imageDataUrl && (
                    <span className="flex h-full items-center justify-center text-[10px] text-canvas-text-muted text-center px-1">
                      {t('未选图片')}
                    </span>
                  )}
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => canvasImageRef.current?.click()}
                    className="px-3 py-1.5 text-xs font-medium bg-canvas-card border border-canvas-border rounded-lg text-canvas-text hover:bg-canvas-hover"
                  >
                    {t('选择画布图片')}
                  </button>
                  {active.canvas.imageDataUrl && (
                    <button
                      type="button"
                      onClick={() => update((theme) => ({ ...theme, canvas: { ...theme.canvas, imageDataUrl: undefined } }))}
                      className="px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 rounded-lg"
                    >
                      {t('移除图片')}
                    </button>
                  )}
                  <input
                    ref={canvasImageRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void setCanvasImage(file);
                      e.currentTarget.value = '';
                    }}
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div className="p-3 settings-sub-card rounded-xl flex items-center justify-between">
                <label className="text-xs font-semibold text-canvas-text cursor-pointer select-none" htmlFor="canvasGridCheckbox">
                  {t('显示网格')}
                </label>
                <input
                  id="canvasGridCheckbox"
                  type="checkbox"
                  checked={active.canvas.gridVisible}
                  onChange={(e) => update((theme) => ({ ...theme, canvas: { ...theme.canvas, gridVisible: e.target.checked } }))}
                  className="w-4 h-4 text-brand rounded border-canvas-border focus:ring-brand cursor-pointer"
                />
              </div>
              <ColorCardInput
                label={t('网格颜色')}
                value={active.canvas.gridColor}
                fallbackColor={active.mode === 'light' ? '#B1B1B7' : '#585868'}
                onChange={(value) => update((theme) => ({ ...theme, canvas: { ...theme.canvas, gridColor: value } }))}
              />
            </div>
          </div>

          {/* Node Appearance Settings */}
          <div className="p-4 settings-sub-card rounded-xl space-y-3">
            <div className="flex items-center justify-between pb-1 border-b settings-h-divider">
              <span className="text-xs font-bold text-canvas-text">{t('节点外观')}</span>
              <span className="text-[11px] text-canvas-text-muted">{t('所有节点共用样式')}</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <ColorCardInput
                label={t('节点底色')}
                value={active.node.background}
                fallbackColor={active.mode === 'light' ? '#FFFFFF' : '#14141c'}
                onChange={(value) => update((theme) => ({ ...theme, node: { ...theme.node, background: value } }))}
              />
              <ColorCardInput
                label={t('节点边框')}
                value={active.node.border}
                fallbackColor={active.mode === 'light' ? '#E4E8F2' : '#2a2a3a'}
                onChange={(value) => update((theme) => ({ ...theme, node: { ...theme.node, border: value } }))}
              />
              <ColorCardInput
                label={t('选中边框')}
                value={active.node.selectedBorder}
                fallbackColor={active.mode === 'light' ? '#7280E4' : '#6366f1'}
                onChange={(value) => update((theme) => ({ ...theme, node: { ...theme.node, selectedBorder: value } }))}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 pt-2">
              <div className="p-3 settings-sub-card rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-canvas-text">{t('节点圆角')}</span>
                  <NumberStepper
                    value={active.node.radius}
                    min={0}
                    max={24}
                    step={1}
                    unit="px"
                    size="sm"
                    onChange={(radius) => update((theme) => ({ ...theme, node: { ...theme.node, radius } }))}
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={24}
                  value={active.node.radius}
                  onChange={(e) => update((theme) => ({ ...theme, node: { ...theme.node, radius: Number(e.target.value) } }))}
                  className="w-full accent-brand cursor-pointer"
                />
              </div>

              <div className="p-3 settings-sub-card rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-canvas-text">{t('节点边框宽度')}</span>
                  <NumberStepper
                    value={active.node.borderWidth}
                    min={0}
                    max={3}
                    step={0.5}
                    precision={1}
                    unit="px"
                    size="sm"
                    onChange={(borderWidth) => update((theme) => ({ ...theme, node: { ...theme.node, borderWidth } }))}
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={3}
                  step={0.5}
                  value={active.node.borderWidth}
                  onChange={(e) => update((theme) => ({ ...theme, node: { ...theme.node, borderWidth: Number(e.target.value) } }))}
                  className="w-full accent-brand cursor-pointer"
                />
              </div>
            </div>
          </div>
        </div>
      </SectionCard>
      {/* END: Canvas & Node Appearance Section */}

      {/* BEGIN: CursorSection */}
      <section data-purpose="cursor-styling">
        <button
          type="button"
          onClick={async () => {
            const next = !customCursor;
            updateConfig({ customCursor: next });
            try {
              await saveConfig({ silent: true });
            } catch {
              showToast(t('指针样式设置保存失败'), 'error');
            }
          }}
          aria-pressed={customCursor}
          className={`sidebar-pref-card w-full p-3 !rounded-2xl shadow-xs transition-colors ${
            customCursor ? 'is-floating' : ''
          }`}
        >
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors ${
              customCursor ? 'bg-brand/15 text-brand-light' : 'bg-canvas-surface text-canvas-text-secondary border border-canvas-border'
            }`}
            aria-hidden="true"
          >
            <Icon icon="mdi:cursor-default-outline" width="18" height="18" />
          </span>

          <div className="sidebar-pref-text text-left flex-1 min-w-0">
            <div className="sidebar-pref-title text-sm font-semibold text-canvas-text">{t('自定义指针样式')}</div>
            <div className="sidebar-pref-desc text-xs text-canvas-text-muted mt-0.5">
              {customCursor
                ? t('使用内置指针，跟随明暗主题自动切换黑白')
                : t('使用系统默认指针')}
            </div>
          </div>

          <div className="sidebar-pref-switch shrink-0" aria-hidden="true">
            <span />
          </div>
        </button>
      </section>
      {/* END: CursorSection */}

      {/* Confirmation Modal */}
      <ModalOverlay
        isOpen={confirmation !== null}
        onClose={() => setConfirmation(null)}
        ariaLabel={confirmation?.kind === 'delete' ? t('确认删除预设') : t('确认覆盖当前预设')}
        className="w-[min(420px,calc(100vw-32px))] p-5 bg-canvas-surface border border-canvas-border rounded-2xl"
        motionPreset="quick"
      >
        <div className="flex items-start gap-3">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${confirmation?.kind === 'delete' ? 'bg-danger/10 text-danger' : 'bg-brand/10 text-brand'}`}>
            <Icon icon={confirmation?.kind === 'delete' ? 'lucide:trash-2' : 'lucide:refresh-cw'} width="19" height="19" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-canvas-text">
              {confirmation?.kind === 'delete' ? t('确认删除预设') : t('确认覆盖当前预设')}
            </h3>
            <p className="mt-2 text-xs leading-5 text-canvas-text-secondary">
              {confirmation?.kind === 'delete'
                ? t('确定要删除预设“{name}”吗？此操作无法恢复。', { name: confirmation.theme.name })
                : t('将当前外观配置覆盖到预设“{name}”，原配置会被替换。', { name: confirmation?.theme.name ?? '' })}
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <AnimatedButton type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setConfirmation(null)}>
            {t('取消')}
          </AnimatedButton>
          <AnimatedButton
            type="button"
            className={`ui-btn ui-btn--sm ${confirmation?.kind === 'delete' ? 'ui-btn--danger' : 'ui-btn--primary'}`}
            onClick={() => void confirmPresetAction()}
          >
            {confirmation?.kind === 'delete' ? t('确认删除') : t('确认覆盖')}
          </AnimatedButton>
        </div>
      </ModalOverlay>
    </main>
  );
}
