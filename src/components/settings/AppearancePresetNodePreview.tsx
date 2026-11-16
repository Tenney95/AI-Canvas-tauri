import { Icon } from '@iconify/react';
import type { Node } from '@xyflow/react';
import { getNodeTypeConfig, type AppearanceTheme, type BaseNodeData } from '../../types';
import { isTransparentColor, resolveAppearanceBackground, resolveAppearanceTheme } from '../../services/appearance/appearanceRuntime';
import { useT } from '../../i18n';

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

export default function PresetSingleNodePreview({
  theme,
  index,
  realNodes,
}: {
  theme: AppearanceTheme;
  index: number;
  realNodes: Node<BaseNodeData>[];
}) {
  const t = useT();
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
    label = data.label || t(config.label || '节点');
    icon = config.icon || 'mdi:cube-outline';
    iconColor = themeResolved.ui.accent;
    displayId = data.displayId;
    badgeText = data.model ? data.model.split('/').pop() || 'AI' : t(config.label || '节点');

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
    label = t(template.label);
    icon = template.icon;
    iconColor = template.iconColor;
    badgeText = t(template.badge || '空白');
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
          background: resolveAppearanceBackground(isTransparentColor(themeResolved.node.background)
            ? 'transparent'
            : themeResolved.node.background, themeResolved.node.backgroundImage),
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
                <span className="truncate opacity-75">{promptText || t('输入提示词生成图像…')}</span>
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
                <span className="text-[8px] opacity-75">{t('等待生成图像')}</span>
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
                <span className="truncate opacity-75">{promptText || t('输入视频运镜描述…')}</span>
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
                <span className="text-[8px] opacity-75">{t('等待生成视频')}</span>
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
              <span className="truncate opacity-75">{promptText || t('输入文本提示词…')}</span>
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
