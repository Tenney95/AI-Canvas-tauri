/**
 * toolbarRegistry.ts — 各节点类型 Toolbar 的按钮注册表与默认布局
 */
import type { NodeType, ToolbarButtonDef, ToolbarZoneLayout, ToolbarLayout } from '../../../../types';
import type { AvailableNodePluginTool, InstalledPlugin } from '../../../../types/plugin';
import { getAvailableNodePluginTools } from '../../../../services/plugins/pluginRuntime';

// ── 通用图标（复用 inline SVG 太繁琐，用 iconify name，回退到 emoji）──

export const TOOLBAR_MORE_KEY = 'more';

export function getPluginToolbarButtonKey(pluginTool: AvailableNodePluginTool): string {
  return `${pluginTool.pluginId}:${pluginTool.tool.id}`;
}

/** 把启用插件贡献的节点工具映射为可编辑 Toolbar 按钮；默认不进入布局，因此显示在“更多”。 */
export function getPluginToolbarButtonRegistry(
  plugins: InstalledPlugin[],
  nodeType: string,
): ToolbarButtonDef[] {
  return getAvailableNodePluginTools(plugins, nodeType as NodeType, 'node-toolbar').map((pluginTool) => ({
    key: getPluginToolbarButtonKey(pluginTool),
    label: `${pluginTool.tool.title} · ${pluginTool.pluginName}`,
    icon: pluginTool.tool.icon || 'lucide:blocks',
    defaultZone: '更多',
  }));
}

function createMoreButton(defaultZone: string): ToolbarButtonDef {
  return {
    key: TOOLBAR_MORE_KEY,
    label: '更多',
    icon: 'mdi:dots-horizontal',
    defaultZone,
  };
}

/** 文本节点按钮 */
export const TEXT_BUTTONS: ToolbarButtonDef[] = [
  { key: 'copy',           label: '复制',        icon: 'mdi:content-copy',             defaultZone: '常用' },
  { key: 'clearEmptyLines',label: '清除空行',    icon: 'mdi:format-line-spacing',       defaultZone: '常用' },
  { key: 'showPrompt',     label: '查看提示词',  icon: 'mdi:message-text-outline',      defaultZone: '常用' },
  { key: 'fullscreen',     label: '全屏显示',    icon: 'mdi:fullscreen',                defaultZone: '常用' },
  createMoreButton('常用'),
];

/** 视频节点按钮 */
export const VIDEO_BUTTONS: ToolbarButtonDef[] = [
  { key: 'copyFile',      label: '复制视频',    icon: 'mdi:content-copy',             defaultZone: '常用' },
  { key: 'captureFrame',   label: '截取帧',      icon: 'mdi:camera-outline',            defaultZone: '常用' },
  { key: 'showPrompt',     label: '查看提示词',  icon: 'mdi:message-text-outline',      defaultZone: '常用' },
  { key: 'reversePrompt',  label: '反推提示词',  icon: 'mdi:text-search',               defaultZone: '常用' },
  { key: 'fullscreen',     label: '全屏预览',    icon: 'mdi:fullscreen',                defaultZone: '常用' },
  createMoreButton('常用'),
];

/** 全景图节点按钮 */
export const PANORAMA_BUTTONS: ToolbarButtonDef[] = [
  { key: 'upload',         label: '上传全景图',  icon: 'mdi:upload',                    defaultZone: '常用' },
  { key: 'toggleMode',     label: '切换视图模式',icon: 'mdi:rotate-3d',                  defaultZone: '常用' },
  { key: 'screenshot',     label: '截图当前视角',icon: 'mdi:camera',                     defaultZone: '常用' },
  { key: 'fullscreen',     label: '全屏显示',    icon: 'mdi:fullscreen',                defaultZone: '常用' },
  createMoreButton('常用'),
];

/** 图像节点按钮 */
export const IMAGE_BUTTONS: ToolbarButtonDef[] = [
  { key: 'matting',        label: '遮罩编辑器',  icon: 'mdi:circle-edit-outline',       defaultZone: 'Primary' },
  { key: 'expand',         label: '扩图',        icon: 'mdi:arrow-expand-all',           defaultZone: 'Primary' },
  { key: 'multiGrid',      label: '宫格裁切',    icon: 'mdi:grid',                       defaultZone: 'Primary' },
  { key: 'cameraStudio',   label: '小逻摄影棚',  icon: 'mdi:camera-control',              defaultZone: 'Primary' },
  // 行为与文本/视频节点的 showPrompt 一致（都是打开节点对话框），统一成同一套文案与图标；
  // key 仍保留 repaint，避免用户已保存的工具栏布局丢掉这个按钮
  { key: 'repaint',        label: '查看提示词',  icon: 'mdi:message-text-outline',       defaultZone: 'Primary' },
  { key: 'upscale',        label: '高清超分',    icon: 'mdi:image-auto-adjust',          defaultZone: 'Primary' },
  { key: 'subjectMatting', label: '自动识别主体',icon: 'mdi:hexagon-outline',             defaultZone: 'Primary' },
  { key: 'annotate',       label: '标注',        icon: 'mdi:draw-pen',                   defaultZone: 'Primary' },
  { key: 'crop',           label: '裁切',        icon: 'mdi:crop',                       defaultZone: 'Primary' },
  { key: 'compose',        label: '多图编辑',    icon: 'mdi:layers-triple-outline',      defaultZone: 'Primary' },
  createMoreButton('Primary'),
  { key: 'upload',         label: '上传图片',    icon: 'mdi:upload',                     defaultZone: 'Primary' },
  { key: 'reversePrompt',  label: '反推提示词',  icon: 'mdi:text-search',                defaultZone: 'Primary' },
  { key: 'copyFile',       label: '复制图像',    icon: 'mdi:content-copy',               defaultZone: 'Secondary' },
  { key: 'history',        label: '生成历史',    icon: 'mdi:history',                  defaultZone: 'Secondary' },
  { key: 'fullscreen',     label: '全屏显示',    icon: 'mdi:fullscreen',                defaultZone: 'Secondary' },
];

/** 音频节点按钮 */
export const AUDIO_BUTTONS: ToolbarButtonDef[] = [
  { key: 'togglePlay',     label: '播放/暂停',   icon: 'mdi:play-pause',                defaultZone: '常用' },
  { key: 'speechToText',   label: '语音转文本',  icon: 'mdi:microphone-message',         defaultZone: '常用' },
  { key: 'transcribe',     label: '转录音频',    icon: 'mdi:text-box-search-outline',   defaultZone: '常用' },
  { key: 'copyFile',      label: '复制音频',    icon: 'mdi:content-copy',             defaultZone: '常用' },
  { key: 'upload',         label: '上传音频',    icon: 'mdi:upload',                     defaultZone: '常用' },
  { key: 'fullscreen',     label: '全屏显示',    icon: 'mdi:fullscreen',                defaultZone: '常用' },
  createMoreButton('常用'),
];

// ── 默认布局 ──

function buildLayout(buttons: ToolbarButtonDef[], version = 1): ToolbarLayout {
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
  return { zones, version };
}

export const DEFAULT_TEXT_LAYOUT      = buildLayout(TEXT_BUTTONS, 2);
export const DEFAULT_VIDEO_LAYOUT     = buildLayout(VIDEO_BUTTONS, 2);
export const DEFAULT_PANORAMA_LAYOUT  = buildLayout(PANORAMA_BUTTONS, 2);
export const DEFAULT_IMAGE_LAYOUT     = buildLayout(IMAGE_BUTTONS, 8);
export const DEFAULT_AUDIO_LAYOUT     = buildLayout(AUDIO_BUTTONS, 3);

/**
 * 迁移图像工具栏的新内置能力与默认分区。
 * 只有能精确识别为历史默认值的布局才会整体换新；其他布局仅执行必要的能力迁移，
 * 保留用户已有的分区、排序和删减结果。
 */
function migrateImageLayoutToV7(layout: ToolbarLayout): ToolbarLayout {
  if (layout.version >= 7) return layout;

  let cameraStudioInserted = layout.zones.some((zone) => zone.buttonKeys.includes('cameraStudio'));

  let zones = layout.zones.map((zone) => {
    const buttonKeys: string[] = [];
    for (const key of zone.buttonKeys) {
      if (key === 'multiAngle') {
        if (!cameraStudioInserted) {
          buttonKeys.push('cameraStudio');
          cameraStudioInserted = true;
        }
        continue;
      }
      buttonKeys.push(key);
    }
    return { ...zone, buttonKeys };
  });

  if (!cameraStudioInserted && layout.version < 3) {
    const targetIndex = zones.findIndex((zone) => zone.name === 'Primary');
    if (targetIndex >= 0) {
      zones[targetIndex] = { ...zones[targetIndex], buttonKeys: [...zones[targetIndex].buttonKeys, 'cameraStudio'] };
    } else {
      zones.push({ id: 'zone-camera-studio', name: 'Primary', buttonKeys: ['cameraStudio'] });
    }
  }

  if (!zones.some((zone) => zone.buttonKeys.includes('history'))) {
    const targetIndex = zones.findIndex((zone) => zone.name === 'Secondary');
    if (targetIndex >= 0) {
      zones[targetIndex] = { ...zones[targetIndex], buttonKeys: [...zones[targetIndex].buttonKeys, 'history'] };
    } else if (zones.length > 0) {
      const lastIndex = zones.length - 1;
      zones[lastIndex] = { ...zones[lastIndex], buttonKeys: [...zones[lastIndex].buttonKeys, 'history'] };
    } else {
      zones = [{ id: 'zone-image-history', name: 'Secondary', buttonKeys: ['history'] }];
    }
  }

  if (layout.version === 4) {
    zones = zones.map((zone) => {
      const historyIndex = zone.buttonKeys.indexOf('history');
      const fullscreenIndex = zone.buttonKeys.indexOf('fullscreen');
      if (historyIndex < 0 || fullscreenIndex !== historyIndex + 1) return zone;
      const buttonKeys = [...zone.buttonKeys];
      [buttonKeys[historyIndex], buttonKeys[fullscreenIndex]] = [
        buttonKeys[fullscreenIndex],
        buttonKeys[historyIndex],
      ];
      return { ...zone, buttonKeys };
    });
  }

  // v5 和短暂使用过的 v6 默认布局都迁移到“复制、历史、全屏”右侧分区。
  const legacyDefaultLayouts = [
    [
      ['matting', 'expand', 'multiGrid', 'cameraStudio', 'repaint', 'upscale', 'subjectMatting'],
      ['annotate', 'crop', 'compose', 'upload', 'copyFile', 'fullscreen', 'history'],
    ],
    [
      [
        'matting', 'expand', 'multiGrid', 'cameraStudio', 'repaint', 'upscale',
        'subjectMatting', 'annotate', 'crop', 'compose', 'upload', 'copyFile',
      ],
      ['fullscreen', 'history'],
    ],
  ];
  const usesLegacyDefaultLayout = legacyDefaultLayouts.some((legacyZones) => (
    zones.length === legacyZones.length
    && zones.every((zone, index) => (
      zone.buttonKeys.length === legacyZones[index].length
      && zone.buttonKeys.every((key, keyIndex) => key === legacyZones[index][keyIndex])
    ))
  ));

  if (usesLegacyDefaultLayout) return getDefaultLayout('ai-image');

  return { ...layout, zones, version: 7 };
}

/**
 * 为音频工具栏补入一次本地「语音转文本」按钮。
 * 只插入用户还没手动移除过的布局，插入位置紧跟播放/暂停。
 * 这里不升版本号，留给下面统一的“更多”按钮迁移去收尾。
 */
function migrateAudioLayout(layout: ToolbarLayout): ToolbarLayout {
  if (layout.zones.some((zone) => zone.buttonKeys.includes('speechToText'))) return layout;

  const zones = layout.zones.map((zone) => ({ ...zone, buttonKeys: [...zone.buttonKeys] }));
  const zoneIndex = zones.findIndex((zone) => zone.buttonKeys.includes('togglePlay'));
  if (zoneIndex >= 0) {
    const insertAt = zones[zoneIndex].buttonKeys.indexOf('togglePlay') + 1;
    zones[zoneIndex].buttonKeys.splice(insertAt, 0, 'speechToText');
    return { ...layout, zones };
  }
  if (zones.length > 0) {
    zones[0].buttonKeys.unshift('speechToText');
    return { ...layout, zones };
  }
  return { ...layout, zones: [{ id: 'zone-audio-asr', name: '常用', buttonKeys: ['speechToText'] }] };
}

/**
 * 为旧布局补入一次“更多”按钮。布局升到当前版本后，用户主动隐藏“更多”不会再被补回。
 */
export function migrateToolbarLayout(nodeType: string, layout: ToolbarLayout): ToolbarLayout {
  // 版本号按节点类型各自推进：给音频加按钮不该把文本、视频的布局也重新迁移一遍
  const targetVersion = nodeType === 'ai-image'
    ? 8
    : nodeType === 'ai-audio'
      ? 3
      : ['ai-text', 'ai-video', 'ai-panorama'].includes(nodeType)
        ? 2
        : layout.version;
  if (layout.version >= targetVersion) return layout;

  const migrated = nodeType === 'ai-image'
    ? migrateImageLayoutToV7(layout)
    : nodeType === 'ai-audio'
      ? migrateAudioLayout(layout)
      : layout;
  if (migrated.version >= targetVersion) return migrated;

  const moreButton = getButtonRegistry(nodeType).find((button) => button.key === TOOLBAR_MORE_KEY);
  if (!moreButton) return migrated;

  let zones = migrated.zones.map((zone) => ({ ...zone, buttonKeys: [...zone.buttonKeys] }));
  const alreadyAdded = zones.some((zone) => zone.buttonKeys.includes(TOOLBAR_MORE_KEY));
  if (!alreadyAdded) {
    let targetIndex = zones.findIndex((zone) => zone.name === moreButton.defaultZone);
    if (targetIndex < 0) targetIndex = zones.length - 1;

    if (targetIndex >= 0) {
      const targetZone = zones[targetIndex];
      const buttonKeys = [...targetZone.buttonKeys];
      const composeIndex = nodeType === 'ai-image' ? buttonKeys.indexOf('compose') : -1;
      buttonKeys.splice(composeIndex >= 0 ? composeIndex + 1 : buttonKeys.length, 0, TOOLBAR_MORE_KEY);
      zones[targetIndex] = { ...targetZone, buttonKeys };
    } else {
      zones = [{ id: 'zone-more', name: moreButton.defaultZone, buttonKeys: [TOOLBAR_MORE_KEY] }];
    }
  }

  return { ...migrated, zones, version: targetVersion };
}

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

/** 返回未出现在当前布局中的已注册按钮；“更多”自身不收纳自己。 */
export function getHiddenDefaultToolbarButtons(
  registry: ToolbarButtonDef[],
  activeButtonKeys: ReadonlySet<string>,
): ToolbarButtonDef[] {
  return registry.filter((button) => (
    button.key !== TOOLBAR_MORE_KEY && !activeButtonKeys.has(button.key)
  ));
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
