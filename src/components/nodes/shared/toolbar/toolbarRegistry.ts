/**
 * toolbarRegistry.ts — 各节点类型 Toolbar 的按钮注册表与默认布局
 */
import type { ToolbarButtonDef, ToolbarZoneLayout, ToolbarLayout } from '../../../../types';

// ── 通用图标（复用 inline SVG 太繁琐，用 iconify name，回退到 emoji）──

/** 文本节点按钮 */
export const TEXT_BUTTONS: ToolbarButtonDef[] = [
  { key: 'copy',           label: '复制',        icon: 'mdi:content-copy',             defaultZone: '常用' },
  { key: 'clearEmptyLines',label: '清除空行',    icon: 'mdi:format-line-spacing',       defaultZone: '常用' },
  { key: 'showPrompt',     label: '查看提示词',  icon: 'mdi:message-text-outline',      defaultZone: '常用' },
  { key: 'fullscreen',     label: '全屏显示',    icon: 'mdi:fullscreen',                defaultZone: '常用' },
];

/** 视频节点按钮 */
export const VIDEO_BUTTONS: ToolbarButtonDef[] = [
  { key: 'copyFile',      label: '复制视频',    icon: 'mdi:content-copy',             defaultZone: '常用' },
  { key: 'captureFrame',   label: '截取当前帧',  icon: 'mdi:camera-outline',            defaultZone: '常用' },
  { key: 'fullscreen',     label: '全屏预览',    icon: 'mdi:fullscreen',                defaultZone: '常用' },
];

/** 全景图节点按钮 */
export const PANORAMA_BUTTONS: ToolbarButtonDef[] = [
  { key: 'upload',         label: '上传全景图',  icon: 'mdi:upload',                    defaultZone: '常用' },
  { key: 'toggleMode',     label: '切换视图模式',icon: 'mdi:rotate-3d',                  defaultZone: '常用' },
  { key: 'screenshot',     label: '截图当前视角',icon: 'mdi:camera',                     defaultZone: '常用' },
  { key: 'fullscreen',     label: '全屏显示',    icon: 'mdi:fullscreen',                defaultZone: '常用' },
];

/** 图像节点按钮 */
export const IMAGE_BUTTONS: ToolbarButtonDef[] = [
  { key: 'matting',        label: '遮罩编辑器',  icon: 'mdi:circle-edit-outline',       defaultZone: 'Primary' },
  { key: 'expand',         label: '扩图',        icon: 'mdi:arrow-expand-all',           defaultZone: 'Primary' },
  { key: 'multiGrid',      label: '宫格裁切',    icon: 'mdi:grid',                       defaultZone: 'Primary' },
  { key: 'multiAngle',     label: '控制角度',    icon: 'mdi:cube-outline',               defaultZone: 'Primary' },
  { key: 'repaint',        label: '重绘',        icon: 'mdi:draw',                       defaultZone: 'Primary' },
  { key: 'upscale',        label: '高清超分',    icon: 'mdi:image-auto-adjust',          defaultZone: 'Primary' },
  { key: 'subjectMatting', label: '自动识别主体',icon: 'mdi:hexagon-outline',             defaultZone: 'Primary' },
  { key: 'annotate',       label: '标注',        icon: 'mdi:draw-pen',                   defaultZone: 'Secondary' },
  { key: 'crop',           label: '裁切',        icon: 'mdi:crop',                       defaultZone: 'Secondary' },
  { key: 'compose',        label: '多图编辑',    icon: 'mdi:layers-triple-outline',      defaultZone: 'Secondary' },
  { key: 'upload',         label: '上传图片',    icon: 'mdi:upload',                     defaultZone: 'Secondary' },
  { key: 'copyFile',      label: '复制图像',    icon: 'mdi:content-copy',             defaultZone: 'Secondary' },
  { key: 'fullscreen',     label: '全屏显示',    icon: 'mdi:fullscreen',                defaultZone: 'Secondary' },
];

/** 音频节点按钮 */
export const AUDIO_BUTTONS: ToolbarButtonDef[] = [
  { key: 'togglePlay',     label: '播放/暂停',   icon: 'mdi:play-pause',                defaultZone: '常用' },
  { key: 'transcribe',     label: '转录音频',    icon: 'mdi:text-box-search-outline',   defaultZone: '常用' },
  { key: 'copyFile',      label: '复制音频',    icon: 'mdi:content-copy',             defaultZone: '常用' },
  { key: 'upload',         label: '上传音频',    icon: 'mdi:upload',                     defaultZone: '常用' },
  { key: 'fullscreen',     label: '全屏显示',    icon: 'mdi:fullscreen',                defaultZone: '常用' },
];

// ── 默认布局 ──

function buildLayout(buttons: ToolbarButtonDef[]): ToolbarLayout {
  const zoneMap = new Map<string, string[]>();
  for (const btn of buttons) {
    const keys = zoneMap.get(btn.defaultZone) || [];
    keys.push(btn.key);
    zoneMap.set(btn.defaultZone, keys);
  }
  const zones: ToolbarZoneLayout[] = [];
  let idx = 0;
  for (const [name, buttonKeys] of zoneMap) {
    zones.push({ id: `zone-${idx++}`, name, buttonKeys });
  }
  return { zones, version: 1 };
}

export const DEFAULT_TEXT_LAYOUT      = buildLayout(TEXT_BUTTONS);
export const DEFAULT_VIDEO_LAYOUT     = buildLayout(VIDEO_BUTTONS);
export const DEFAULT_PANORAMA_LAYOUT  = buildLayout(PANORAMA_BUTTONS);
export const DEFAULT_IMAGE_LAYOUT     = buildLayout(IMAGE_BUTTONS);
export const DEFAULT_AUDIO_LAYOUT     = buildLayout(AUDIO_BUTTONS);

/** 根据 nodeType 获取按钮注册表 */
export function getButtonRegistry(nodeType: string): ToolbarButtonDef[] {
  switch (nodeType) {
    case 'ai-text':     return TEXT_BUTTONS;
    case 'ai-video':    return VIDEO_BUTTONS;
    case 'ai-panorama': return PANORAMA_BUTTONS;
    case 'ai-image':    return IMAGE_BUTTONS;
    case 'ai-audio':    return AUDIO_BUTTONS;
    default:            return [];
  }
}

/** 根据 nodeType 获取默认布局 */
export function getDefaultLayout(nodeType: string): ToolbarLayout {
  const deepClone = (layout: ToolbarLayout): ToolbarLayout => ({
    ...layout,
    zones: layout.zones.map((z: ToolbarZoneLayout) => ({ ...z, buttonKeys: [...z.buttonKeys] })),
  });
  switch (nodeType) {
    case 'ai-text':     return deepClone(DEFAULT_TEXT_LAYOUT);
    case 'ai-video':    return deepClone(DEFAULT_VIDEO_LAYOUT);
    case 'ai-panorama': return deepClone(DEFAULT_PANORAMA_LAYOUT);
    case 'ai-image':    return deepClone(DEFAULT_IMAGE_LAYOUT);
    case 'ai-audio':    return deepClone(DEFAULT_AUDIO_LAYOUT);
    default:            return { zones: [], version: 1 };
  }
}
