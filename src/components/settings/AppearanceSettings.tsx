/**
 * AppearanceSettings — 提供外观设置界面与交互。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@iconify/react';
import { useAppStore } from '../../store/useAppStore';
import type { AppearanceCanvasPanelId, AppearanceTheme } from '../../types';
import { getBuiltinAppearanceTheme, normalizeAppearanceTheme } from '../../services/appearance/appearanceDefaults';
import { resolveAppearanceMode, resolveAppearancePanelBackground, resolveAppearanceTheme, setAppearancePanelLinked, updateAppearancePanelBackground } from '../../services/appearance/appearanceRuntime';
import { exportAppearanceTheme, importAppearanceTheme } from '../../services/appearance/appearanceThemeService';
import { saveBinaryToLocalFile } from '../../services/fileService';
import { isTauriEnv, sanitizeFileName } from '../../services/fs/core';
import { registerSettingsProducer } from '../../services/configPersistenceQueue';
import AnimatedButton from '../shared/AnimatedButton';
import ModalOverlay from '../shared/ModalOverlay';
import Select from '../shared/Select';
import NumberStepper from '../shared/NumberStepper';
import CanvasImageBackground from '../backgrounds/CanvasImageBackground';
import AppearanceLayoutPreview, { type AppearanceLayoutTarget } from './AppearanceLayoutPreview';
import AppearanceComponentPreview from './AppearanceComponentPreview';
import {
  BackgroundImageControls, ButtonAppearanceControls, CanvasImageAdjustments, ColorCardInput, GlassMaterialControls,
} from './appearance/AppearanceSurfaceControls';
import { imagePreviewStyle, uploadThemeImage } from './appearance/appearanceThemeImages';
import PresetSingleNodePreview from './AppearancePresetNodePreview';
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
  const [presetOperation, setPresetOperation] = useState<'import' | 'export' | 'save' | 'overwrite' | 'delete' | 'activate' | 'rename' | null>(null);
  const presetOperationRef = useRef(false);

  const beginPresetOperation = (operation: NonNullable<typeof presetOperation>) => {
    if (presetOperationRef.current) return false;
    presetOperationRef.current = true;
    setPresetOperation(operation);
    return true;
  };
  const endPresetOperation = () => {
    presetOperationRef.current = false;
    setPresetOperation(null);
  };

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

  const update = (patch: (theme: AppearanceTheme) => AppearanceTheme | null) => {
    if (presetOperationRef.current) return;
    // 图片读取是异步的；使用最新草稿，避免完成上传时覆盖其间的其他编辑。
    const editable = structuredClone(draftRef.current ?? normalizeAppearanceTheme(useAppStore.getState().config.appearance ?? savedActive));
    const patched = patch(editable);
    if (!patched) return;
    const next = normalizeAppearanceTheme(patched);
    draftRef.current = next;
    setDraft(next);
    setAutoSaveStatus('saving');
    preview(next);
  };

  const updateImage = (patch: (theme: AppearanceTheme) => AppearanceTheme) => {
    try {
      update((theme) => {
        // 切换预设后，不将旧上传任务应用到新主题。
        if (theme.id !== active.id) return null;
        return patch(theme);
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('背景图片设置失败'), 'error');
    }
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

  const selectPreset = async (theme: AppearanceTheme) => {
    if (!beginPresetOperation('activate')) return;
    try {
      await flushDraft();
      await activate(theme);
      draftRef.current = null;
      setDraft(null);
      setAutoSaveStatus('saved');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('外观切换失败'), 'error');
    } finally {
      endPresetOperation();
    }
  };

  const updateMode = async (mode: AppearanceTheme['mode']) => {
    const resolvedMode = resolveAppearanceMode(mode);
    const base = getBuiltinAppearanceTheme(`standard-${resolvedMode}`);
    await selectPreset({ ...base, mode });
  };

  const importTheme = async (file: File) => {
    if (!beginPresetOperation('import')) return;
    try {
      await flushDraft();
      const theme = await importAppearanceTheme(file);
      await saveTheme(theme);
      draftRef.current = null;
      setDraft(null);
      setAutoSaveStatus('idle');
      showToast(t('主题已导入'), 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('主题导入失败'), 'error');
    } finally {
      endPresetOperation();
    }
  };

  const exportTheme = async () => {
    if (!beginPresetOperation('export')) return;
    try {
      const snapshot = draftRef.current ?? active;
      await flushDraft();
      const fileName = `${sanitizeFileName(snapshot.name || 'ai-canvas-theme')}.aicanvas-theme`;
      const blob = await exportAppearanceTheme(snapshot);
      if (isTauriEnv()) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const savedPath = await saveBinaryToLocalFile(bytes, fileName, [
          { name: t('AI Canvas 主题'), extensions: ['aicanvas-theme'] },
          { name: t('JSON 文件'), extensions: ['json'] },
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
    } finally {
      endPresetOperation();
    }
  };

  const setHandleImage = async (file: File) => {
    try {
      const imageDataUrl = await uploadThemeImage(file);
      updateImage((theme) => ({ ...theme, handle: { ...theme.handle, kind: 'image', imageDataUrl } }));
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('图片读取失败'), 'error');
    }
  };

  const savePreset = async () => {
    const name = presetName.trim();
    if (!name) {
      showToast(t('请输入预设名称'), 'info');
      return;
    }
    if (!beginPresetOperation('save')) return;
    try {
      const snapshot = draftRef.current ?? active;
      await flushDraft();
      await duplicateTheme(snapshot, name);
      setPresetName('');
      setIsNamingPreset(false);
      draftRef.current = null;
      setDraft(null);
      setAutoSaveStatus('saved');
      showToast(t('预设已保存'), 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('预设保存失败'), 'error');
    } finally {
      endPresetOperation();
    }
  };

  const renamePreset = async (theme: AppearanceTheme) => {
    if (editingPresetId !== theme.id) return;
    const name = editingPresetName.trim();
    setEditingPresetId(null);
    if (!name || name === theme.name || theme.builtin) return;
    if (!beginPresetOperation('rename')) return;
    try {
      await flushDraft();
      await renameTheme(theme.id, name);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('预设重命名失败'), 'error');
    } finally {
      endPresetOperation();
    }
  };

  const confirmPresetAction = async () => {
    const pending = confirmation;
    if (!pending) return;
    if (!beginPresetOperation(pending.kind)) return;
    setConfirmation(null);
    try {
      const snapshot = draftRef.current ?? active;
      await flushDraft();
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
        ...snapshot,
        id: pending.theme.id,
        name: pending.theme.name,
        builtin: false,
      });
      draftRef.current = null;
      setDraft(null);
      setAutoSaveStatus('saved');
      showToast(t('当前预设已覆盖'), 'success');
    } catch (error) {
      setAutoSaveStatus('error');
      showToast(error instanceof Error ? error.message : t('预设操作失败'), 'error');
    } finally {
      endPresetOperation();
    }
  };

  const layoutControls = {
    canvas: (
      <div className="p-3 settings-sub-card rounded-xl space-y-3">
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
              swatches={active.mode === 'light' ? LIGHT_CANVAS_COLOR_SWATCHES : DARK_CANVAS_COLOR_SWATCHES}
              onChange={(value) => update((theme) => ({ ...theme, canvas: { ...theme.canvas, color: value, kind: 'color' } }))}
            />
          </div>
        )}

        {active.canvas.kind === 'image' && (
          <div className="p-3 settings-sub-card rounded-lg ui-stack">
            <BackgroundImageControls
              key={`${active.id}:canvas-background`}
              label={t('画布背景')}
              preview={<div className="ui-card relative h-28 overflow-hidden" role="img" aria-label={t('画布背景图片预览')}>
                <CanvasImageBackground canvas={active.canvas} baseColor={active.canvas.color} />
                {!active.canvas.imageDataUrl && <span className="relative flex h-full items-center justify-center ui-hint">{t('未选图片')}</span>}
              </div>}
              image={{ kind: 'image', imageDataUrl: active.canvas.imageDataUrl, imageFit: active.canvas.imageFit }}
              onChange={({ kind, imageDataUrl, imageFit }) => updateImage((theme) => ({
                ...theme, canvas: { ...theme.canvas, kind, imageDataUrl, imageFit },
              }))}
            />
            <CanvasImageAdjustments canvas={active.canvas} mode={active.mode}
              onChange={(patch) => update((theme) => ({ ...theme, canvas: { ...theme.canvas, ...patch } }))} />
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 pt-1">
          <label className="p-3 settings-sub-card rounded-xl flex items-center justify-between cursor-pointer">
            <span className="text-xs font-semibold text-canvas-text select-none">
              {t('显示网格')}
            </span>
            <input
              aria-label={t('显示网格')}
              type="checkbox"
              checked={active.canvas.gridVisible}
              onChange={(e) => update((theme) => ({ ...theme, canvas: { ...theme.canvas, gridVisible: e.target.checked } }))}
              className="w-4 h-4 text-brand rounded border-canvas-border focus:ring-brand cursor-pointer"
            />
          </label>
          <ColorCardInput
            label={t('网格颜色')}
            value={active.canvas.gridColor}
            fallbackColor={active.mode === 'light' ? '#B1B1B7' : '#585868'}
            onChange={(value) => update((theme) => ({ ...theme, canvas: { ...theme.canvas, gridColor: value } }))}
          />
        </div>
      </div>
    ),
    background: (
      <ColorCardInput
        label={t('页面背景')}
        value={active.ui.background}
        fallbackColor={active.mode === 'light' ? '#F4F6FB' : '#0a0a0f'}
        onChange={(value) => update((theme) => ({ ...theme, ui: { ...theme.ui, background: value } }))}
      />
    ),
    surface: (
      <div className="ui-stack">
        <ColorCardInput
          key={`${active.id}:surface-background`}
          label={t('窗口 / 弹窗背景')}
          value={active.ui.surface}
          image={active.ui.surfaceImage}
          onImageChange={(surfaceImage) => updateImage((theme) => ({ ...theme, ui: { ...theme.ui, surfaceImage } }))}
          fallbackColor={active.mode === 'light' ? '#FFFFFF' : '#14141c'}
          onChange={(value) => update((theme) => ({ ...theme, ui: { ...theme.ui, surface: value } }))}
        />
        <GlassMaterialControls opacity={resolved.ui.glassOpacity} blur={resolved.ui.glassBlur}
          onOpacityChange={(glassOpacity) => update((theme) => ({ ...theme, ui: { ...theme.ui, glassOpacity } }))}
          onBlurChange={(glassBlur) => update((theme) => ({ ...theme, ui: { ...theme.ui, glassBlur } }))} />
      </div>
    ),
    card: (
      <ColorCardInput
        label={t('组件底色')}
        value={active.ui.card}
        fallbackColor={active.mode === 'light' ? '#F8FAFD' : '#1a1a26'}
        onChange={(value) => update((theme) => ({ ...theme, ui: { ...theme.ui, card: value } }))}
      />
    ),
    hover: (
      <ColorCardInput
        label={t('组件悬浮底色')}
        value={active.ui.hover}
        fallbackColor={active.mode === 'light' ? '#EEF1F8' : '#252535'}
        onChange={(value) => update((theme) => ({ ...theme, ui: { ...theme.ui, hover: value } }))}
      />
    ),
    border: (
      <ColorCardInput
        label={t('组件边框')}
        value={active.ui.border}
        fallbackColor={active.mode === 'light' ? '#E4E8F2' : '#2a2a3a'}
        onChange={(value) => update((theme) => ({ ...theme, ui: { ...theme.ui, border: value } }))}
      />
    ),
    node: (
      <ColorCardInput
        key={`${active.id}:node-background`}
        label={t('节点底色')}
        value={active.node.background}
        image={active.node.backgroundImage}
        onImageChange={(backgroundImage) => updateImage((theme) => ({ ...theme, node: { ...theme.node, backgroundImage } }))}
        fallbackColor={active.mode === 'light' ? '#FFFFFF' : '#14141c'}
        onChange={(value) => update((theme) => ({ ...theme, node: { ...theme.node, background: value } }))}
      />
    ),
  } satisfies Record<Exclude<AppearanceLayoutTarget, AppearanceCanvasPanelId>, ReactNode>;

  const renderLayoutControls = (target: AppearanceLayoutTarget): ReactNode => {
    switch (target) {
      case 'projectBar':
      case 'sidebar':
      case 'drawingToolbar':
      case 'viewportToolbar': {
        const linked = !active.ui.canvasPanels.overrides[target];
        const background = resolveAppearancePanelBackground(resolved, target);
        return (
          <div className="ui-stack">
            <div className="settings-sub-card rounded-xl p-3 space-y-2">
              <div className="ui-row ui-row--between">
                <span className="text-xs font-semibold text-canvas-text">{t('关联其他区域')}</span>
                <button type="button" role="switch" className="ui-switch" aria-label={t('关联其他区域')}
                  aria-checked={linked} onClick={() => update((theme) => setAppearancePanelLinked(theme, target, !linked))} />
              </div>
              <p className="ui-hint">{linked
                ? t('项目栏、左侧工具栏、绘图工具栏和画布控制栏中，仍关联的区域会一起更新背景。')
                : t('当前背景独立设置；重新关联后将跟随其他关联区域的背景。')}</p>
            </div>
            <ColorCardInput
              key={`${active.id}:${target}:${linked ? 'linked' : 'independent'}`}
              label={t('区域背景')}
              value={background.background}
              image={background.backgroundImage}
              fallbackColor={resolved.mode === 'light' ? '#FFFFFF' : '#14141c'}
              onChange={(value) => update((theme) => updateAppearancePanelBackground(theme, target, { background: value }))}
              onImageChange={(backgroundImage) => updateImage((theme) => updateAppearancePanelBackground(theme, target, { backgroundImage }))}
            />
            <GlassMaterialControls opacity={background.opacity} blur={background.blur}
              onOpacityChange={(opacity) => update((theme) => updateAppearancePanelBackground(theme, target, { opacity }))}
              onBlurChange={(blur) => update((theme) => updateAppearancePanelBackground(theme, target, { blur }))} />
          </div>
        );
      }
      default: return layoutControls[target];
    }
  };

  return (
    <main className="flex-1 overflow-y-auto px-6 sm:px-6 py-6 settings-appearance-view" data-purpose="appearance-settings-view" aria-busy={presetOperation !== null}>
      <fieldset disabled={presetOperation !== null} className="min-w-0 m-0 border-0 p-0 space-y-6" aria-label={t('外观设置')}>
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
              <p className="text-xs text-canvas-text-muted mt-1">{t('外观预设包含画布、节点、按钮、弹窗、连接线和连接手柄的配色与背景图片')}</p>
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
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => importRef.current?.click()}
              title={t('导入完整外观预设，背景图片会自动保存到本地')}
              className="ui-btn ui-btn--secondary ui-btn--sm"
            >
              <svg className="w-3.5 h-3.5 text-canvas-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
              <span>{presetOperation === 'import' ? t('导入中…') : t('导入')}</span>
            </button>
            <button
              type="button"
              onClick={() => void exportTheme()}
              title={t('导出当前外观和全部背景图片，可在其他设备导入')}
              className="ui-btn ui-btn--secondary ui-btn--sm"
            >
              <svg className="w-3.5 h-3.5 text-canvas-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
              <span>{presetOperation === 'export' ? t('导出中…') : t('导出')}</span>
            </button>

            {isNamingPreset ? (
              <div className="flex flex-wrap items-center gap-1.5">
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
                  aria-label={t('预设名称')}
                  className="ui-input ui-input--sm w-36"
                />
                <button
                  type="button"
                  onClick={() => void savePreset()}
                  className="ui-btn ui-btn--primary ui-btn--sm"
                >
                  {presetOperation === 'save' ? t('保存中…') : t('确定')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPresetName('');
                    setIsNamingPreset(false);
                  }}
                  className="ui-btn ui-btn--ghost ui-btn--sm"
                >
                  {t('取消')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIsNamingPreset(true)}
                title={t('将当前外观保存为新的本地预设，图片按引用保存')}
                className="ui-btn ui-btn--secondary ui-btn--sm"
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
            aria-label={t('导入外观预设文件')}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importTheme(file);
                e.currentTarget.value = '';
              }}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              title={t('恢复当前外观的默认配置，保留已保存预设和当前主题模式')}
              onClick={() => void selectPreset({
                ...getBuiltinAppearanceTheme(active.id, resolveAppearanceMode(active.mode)),
                mode: active.mode,
              })}
              className="ui-btn ui-btn--secondary ui-btn--sm"
            >
              <Icon icon="lucide:rotate-ccw" width="14" height="14" aria-hidden="true" className="text-canvas-text-muted" />
              <span>{t('恢复默认配置')}</span>
            </button>
            <button
              type="button"
              disabled={!currentPreset || currentPreset.builtin}
              title={currentPreset?.builtin ? t('内置预设不可覆盖') : t('覆盖当前预设')}
              onClick={() => {
                if (currentPreset && !currentPreset.builtin) {
                  setConfirmation({ kind: 'overwrite', theme: currentPreset });
                }
              }}
              className="ui-btn ui-btn--secondary ui-btn--sm"
            >
              <svg className="w-3.5 h-3.5 text-canvas-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
              <span>{t('覆盖当前预设')}</span>
            </button>
          </div>
        </div>
        <p className="ui-hint" role="status" aria-live="polite">
          {presetOperation === 'import' ? t('正在校验并恢复预设图片…')
            : presetOperation === 'export' ? t('正在打包当前外观和背景图片…')
            : presetOperation === 'save' || presetOperation === 'overwrite' ? t('正在保存外观预设…')
            : isTauriEnv() ? t('图片保存在安装目录的 theme 文件夹；保存预设复用图片，导出包含完整图片。')
            : t('Web 演示使用内嵌图片；本地图片目录功能请使用桌面端。')}
        </p>
      </div>

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
                  onClick={() => void selectPreset(theme)}
                />
                {/* Solar system background elements */}
                {isSolarSystem && solarPlanet && (
                  <>
                    <div className="solar-stars opacity-80 pointer-events-none" />
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none overflow-hidden" style={{ bottom: '-40%' }}>
                      <img
                        src={solarPlanet.image}
                        alt={t(solarPlanet.name)}
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
            swatches={active.mode === 'light' ? LIGHT_THEME_COLOR_SWATCHES : DARK_THEME_COLOR_SWATCHES}
            onChange={(value) =>
              update((theme) => ({
                ...theme,
                ui: { ...theme.ui, accent: value, accentStrong: value, accentSoft: value, focus: value },
              }))
            }
          />
        </div>
      </SectionCard>
      {/* END: AccentColorSection */}

      {/* BEGIN: SurfaceHierarchySection */}
      <SectionCard
        title={t('界面布局与底色')}
        description={t('按真实画布布局点选区域，调整颜色或背景图片')}
        icon={
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
          </svg>
        }
        dataPurpose="surface-background-colors"
      >
        <AppearanceLayoutPreview
          key={`${active.id}:${active.mode}`}
          theme={active}
          disabled={presetOperation !== null}
          renderControls={renderLayoutControls}
        />
        <details className="pt-3">
          <summary className="cursor-pointer text-xs text-canvas-text-secondary">{t('更多界面配色')}</summary>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {layoutControls.background}
            {layoutControls.surface}
          </div>
        </details>
      </SectionCard>
      {/* END: SurfaceHierarchySection */}

      <SectionCard
        title={t('内部组件配色')}
        description={t('调整卡片、列表、分段选项和输入框，让小块背景与窗口协调')}
        icon={<Icon icon="lucide:panels-top-left" width="16" aria-hidden="true" />}
        dataPurpose="component-colors"
      >
        <p className="ui-hint mb-3">{t('这些配色共用于常规设置、API 厂商卡片、ComfyUI、MCP 等区域；强调选中态沿用主题色。')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {layoutControls.card}
          {layoutControls.hover}
          <ColorCardInput
            label={t('输入框底色')}
            value={active.ui.inputBackground}
            followThemeVar="--theme-input-bg"
            fallbackColor={resolveAppearanceMode(active.mode) === 'light' ? '#FFFFFF' : '#14141c'}
            onChange={(inputBackground) => update((theme) => ({ ...theme, ui: { ...theme.ui, inputBackground } }))}
          />
          {layoutControls.border}
        </div>
        <AppearanceComponentPreview />
      </SectionCard>

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
          {layoutControls.canvas}

          {/* Node Appearance Settings */}
          <div className="p-4 settings-sub-card rounded-xl space-y-3">
            <div className="flex items-center justify-between pb-1 border-b settings-h-divider">
              <span className="text-xs font-bold text-canvas-text">{t('节点外观')}</span>
              <span className="text-[11px] text-canvas-text-muted">{t('所有节点共用样式')}</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              {layoutControls.node}
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
                  swatches={active.mode === 'light' ? LIGHT_THEME_COLOR_SWATCHES : DARK_THEME_COLOR_SWATCHES}
                  onChange={(val) => update((theme) => ({ ...theme, handle: { ...theme.handle, color: val } }))}
                />
              </div>

              {/* Hover Handle Color */}
              <div className="space-y-2 pt-1">
                <ColorCardInput
                  label={t('悬浮颜色')}
                  value={active.handle.hoverColor}
                  fallbackColor={active.mode === 'light' ? '#5A69D4' : '#818cf8'}
                  swatches={active.mode === 'light' ? LIGHT_THEME_COLOR_SWATCHES : DARK_THEME_COLOR_SWATCHES}
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
                      accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg"
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

      <SectionCard
        title={t('按钮外观')}
        description={t('普通按钮和主按钮分别设置纯色或图片背景，默认跟随主题')}
        icon={<Icon icon="lucide:mouse-pointer-2" className="w-4 h-4" aria-hidden="true" />}
        dataPurpose="button-appearance-settings"
      >
        <ButtonAppearanceControls active={active} resolved={resolved} update={update} updateImage={updateImage} />
      </SectionCard>

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
      </fieldset>
    </main>
  );
}
