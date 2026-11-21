import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../../i18n';
import { getBuiltinAppearanceTheme } from '../../../services/appearance/appearanceDefaults';
import { contrastColor, isTransparentColor, resolveAppearanceMode } from '../../../services/appearance/appearanceRuntime';
import { useAppStore } from '../../../store/useAppStore';
import type { AppearanceBackgroundImage, AppearanceTheme } from '../../../types';
import NumberStepper from '../../shared/NumberStepper';
import Select from '../../shared/Select';
import { imagePreviewStyle, uploadThemeImage } from './appearanceThemeImages';

export function BackgroundImageControls({ label, image, onChange, preview }: {
  label: string;
  image: AppearanceBackgroundImage;
  onChange: (image: AppearanceBackgroundImage) => void;
  preview?: ReactNode;
}) {
  const t = useT();
  const showToast = useAppStore((state) => state.showToast);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const latestRef = useRef({ image, onChange });
  const [loading, setLoading] = useState(false);
  useEffect(() => { latestRef.current = { image, onChange }; }, [image, onChange]);
  useEffect(() => () => { requestRef.current += 1; }, []);

  const upload = async (file: File) => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const imageDataUrl = await uploadThemeImage(file);
      if (request !== requestRef.current) return;
      const latest = latestRef.current;
      latest.onChange({ ...latest.image, kind: 'image', imageDataUrl });
    } catch (error) {
      if (request === requestRef.current) showToast(error instanceof Error ? error.message : t('图片读取失败'), 'error');
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  };

  return (
    <div className="ui-stack">
      {preview ?? <div className="ui-card h-20 bg-no-repeat" role="img" aria-label={t('{label}图片预览', { label })} style={imagePreviewStyle(image.imageDataUrl, image.imageFit)}>
        {!image.imageDataUrl && <span className="flex h-full items-center justify-center ui-hint">{t('未选图片')}</span>}
      </div>}
      <div className="ui-row ui-row--tight">
        <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={loading} onClick={() => inputRef.current?.click()}>
          {loading ? t('读取中…') : image.imageDataUrl ? t('替换图片') : t('上传图片')}
        </button>
        {image.imageDataUrl && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={loading}
          onClick={() => onChange({ ...image, kind: 'color', imageDataUrl: undefined })}>{t('移除图片')}</button>}
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg" className="hidden" aria-label={t('{label}上传图片', { label })}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = '';
            if (file) void upload(file);
          }} />
      </div>
      <Select aria-label={t('{label}图片铺放方式', { label })} value={image.imageFit}
        onChange={(value) => onChange({ ...image, imageFit: value as AppearanceBackgroundImage['imageFit'] })}>
        <option value="cover">{t('覆盖填满')}</option>
        <option value="contain">{t('完整显示')}</option>
        <option value="fill">{t('拉伸填满')}</option>
      </Select>
      <p className="ui-hint">{t('PNG / JPG / WebP / SVG，最大 5MB；透明或未铺满的区域沿用底色。')}</p>
    </div>
  );
}

function ImageAdjustmentSlider({ label, value, max = 100, unit = '%', onChange }: {
  label: string;
  value: number;
  max?: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="ui-field">
      <div className="ui-row ui-row--between">
        <label className="ui-label" htmlFor={id}>{label}</label>
        <NumberStepper value={value} min={0} max={max} step={1} unit={unit} size="sm" aria-label={label} onChange={onChange} />
      </div>
      <input id={id} type="range" className="ui-slider" min={0} max={max} step={1} value={value}
        onChange={(event) => onChange(Number(event.target.value))} />
    </div>
  );
}

export function CanvasImageAdjustments({ canvas, mode, onChange }: {
  canvas: AppearanceTheme['canvas'];
  mode: AppearanceTheme['mode'];
  onChange: (patch: Partial<AppearanceTheme['canvas']>) => void;
}) {
  const t = useT();
  const defaults = getBuiltinAppearanceTheme(`standard-${resolveAppearanceMode(mode)}`).canvas;
  return (
    <div className="ui-stack border-t border-canvas-border pt-3">
      <div className="ui-row ui-row--between">
        <span className="ui-label">{t('图片调整')}</span>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => onChange({
          color: defaults.color, imageOpacity: defaults.imageOpacity, imagePosition: defaults.imagePosition,
          imageBlur: defaults.imageBlur, imageBrightness: defaults.imageBrightness,
          imageContrast: defaults.imageContrast, imageSaturation: defaults.imageSaturation,
          imageOverlayColor: defaults.imageOverlayColor, imageOverlayOpacity: defaults.imageOverlayOpacity,
        })}>{t('恢复图片调整')}</button>
      </div>
      <div className="ui-field">
        <span className="ui-label">{t('图片位置')}</span>
        <Select aria-label={t('图片位置')} value={canvas.imagePosition} onChange={(imagePosition) => onChange({ imagePosition })}>
          <option value="left top">{t('左上')}</option><option value="center top">{t('顶部居中')}</option><option value="right top">{t('右上')}</option>
          <option value="left center">{t('左侧居中')}</option><option value="center">{t('居中')}</option><option value="right center">{t('右侧居中')}</option>
          <option value="left bottom">{t('左下')}</option><option value="center bottom">{t('底部居中')}</option><option value="right bottom">{t('右下')}</option>
        </Select>
      </div>
      <ImageAdjustmentSlider label={t('图片透明度')} value={Math.round((1 - canvas.imageOpacity) * 100)} onChange={(value) => onChange({ imageOpacity: (100 - value) / 100 })} />
      <ImageAdjustmentSlider label={t('图片模糊度')} value={canvas.imageBlur} max={40} unit="px" onChange={(imageBlur) => onChange({ imageBlur })} />
      <ImageAdjustmentSlider label={t('亮度')} value={Math.round(canvas.imageBrightness * 100)} max={200} onChange={(value) => onChange({ imageBrightness: value / 100 })} />
      <ImageAdjustmentSlider label={t('对比度')} value={Math.round(canvas.imageContrast * 100)} max={200} onChange={(value) => onChange({ imageContrast: value / 100 })} />
      <ImageAdjustmentSlider label={t('饱和度')} value={Math.round(canvas.imageSaturation * 100)} max={200} onChange={(value) => onChange({ imageSaturation: value / 100 })} />
      <ColorCardInput label={t('图片底色')} value={canvas.color} fallbackColor={defaults.color} onChange={(color) => onChange({ color })} />
      <div className="ui-stack border-t border-canvas-border pt-3">
        <span className="ui-label">{t('蒙版')}</span>
        <ColorCardInput label={t('蒙版颜色')} value={canvas.imageOverlayColor} allowNone={false} fallbackColor={defaults.imageOverlayColor}
          onChange={(imageOverlayColor) => onChange({ imageOverlayColor })} />
        <ImageAdjustmentSlider label={t('蒙版强度')} value={Math.round(canvas.imageOverlayOpacity * 100)} onChange={(value) => onChange({ imageOverlayOpacity: value / 100 })} />
        <p className="ui-hint">{t('图片透明度 100% 时隐藏图片；蒙版强度 0% 时关闭蒙版。')}</p>
      </div>
    </div>
  );
}

export function GlassMaterialControls({ opacity, blur, onOpacityChange, onBlurChange }: {
  opacity: number;
  blur: number;
  onOpacityChange: (value: number) => void;
  onBlurChange: (value: number) => void;
}) {
  const t = useT();
  const id = useId();
  const transparency = Math.round((1 - opacity) * 100);
  return (
    <div className="ui-card p-3 ui-stack">
      <div className="ui-field">
        <div className="ui-row ui-row--between">
          <label className="ui-label" htmlFor={`${id}-opacity`}>{t('背景透明度')}</label>
          <NumberStepper value={transparency} min={0} max={100} step={1} unit="%" size="sm"
            aria-label={t('背景透明度')} onChange={(value) => onOpacityChange((100 - value) / 100)} />
        </div>
        <input id={`${id}-opacity`} type="range" className="ui-slider" min={0} max={100} step={1}
          value={transparency} onChange={(event) => onOpacityChange((100 - Number(event.target.value)) / 100)} />
      </div>
      <div className="ui-field">
        <div className="ui-row ui-row--between">
          <label className="ui-label" htmlFor={`${id}-blur`}>{t('毛玻璃模糊')}</label>
          <NumberStepper value={blur} min={0} max={48} step={1} unit="px" size="sm"
            aria-label={t('毛玻璃模糊')} onChange={onBlurChange} />
        </div>
        <input id={`${id}-blur`} type="range" className="ui-slider" min={0} max={48} step={1}
          value={blur} onChange={(event) => onBlurChange(Number(event.target.value))} />
      </div>
      <p className="ui-hint">{t('透明度只影响背景，文字和图标保持清晰；模糊设为 0 可关闭毛玻璃。')}</p>
    </div>
  );
}

export function ColorCardInput({
  label,
  value,
  onChange,
  allowNone = true,
  fallbackColor = '#6366f1',
  followThemeVar,
  image,
  onImageChange,
  swatches,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  allowNone?: boolean;
  fallbackColor?: string;
  followThemeVar?: string;
  image?: AppearanceBackgroundImage;
  onImageChange?: (image: AppearanceBackgroundImage) => void;
  swatches?: readonly string[];
}) {
  const t = useT();
  const isAuto = Boolean(followThemeVar) && value === 'auto';
  const isNone = isTransparentColor(value);
  const safeHex = /^#[0-9a-f]{6}$/i.test(value) ? value : fallbackColor;
  const imageConfig: AppearanceBackgroundImage = image ?? { kind: 'color', imageFit: 'cover' };
  const stacked = Boolean(followThemeVar || onImageChange);

  return (
    <div className={`p-3 settings-sub-card rounded-xl transition-colors ${stacked ? 'ui-field' : 'flex flex-wrap items-center justify-between gap-2'}`}>
      <div className={`flex items-center gap-2 ${swatches ? 'min-w-min flex-1 flex-wrap' : 'justify-between'}`}>
        <span className={`text-xs font-semibold text-canvas-text ${stacked || swatches ? 'shrink-0 whitespace-nowrap' : ''}`}>{label}</span>
        {swatches && <QuickSwatches colors={swatches} value={value} onChange={onChange} title={label} />}
        {onImageChange && <Select aria-label={t('{label}背景类型', { label })} value={imageConfig.kind} className="shrink-0 w-24" size="sm"
          onChange={(kind) => onImageChange({ ...imageConfig, kind: kind as AppearanceBackgroundImage['kind'] })}>
          <option value="color">{t('纯色')}</option>
          <option value="image">{t('上传图片')}</option>
        </Select>}
      </div>
      {onImageChange && imageConfig.kind === 'image' ? <BackgroundImageControls label={label} image={imageConfig} onChange={onImageChange} /> : (
      <div className={`flex items-center space-x-1.5 settings-sub-card-inner px-2 py-1.5 rounded-lg shadow-2xs ${stacked ? 'min-w-0 max-w-full' : ''}`}>
        <label
          className="relative w-6 h-5 rounded cursor-pointer block border border-black/10 shrink-0 overflow-hidden shadow-2xs"
          style={
            isAuto
              ? { background: `var(${followThemeVar})` }
              : isNone
              ? {
                  background:
                    'linear-gradient(to top right, transparent calc(50% - 1px), #ef4444 calc(50% - 1px), #ef4444 calc(50% + 1px), transparent calc(50% + 1px)), #ffffff',
                }
              : { backgroundColor: safeHex }
          }
          title={isAuto ? t('当前跟随主题，点击选择自定义颜色') : isNone ? t('无颜色（点击选择颜色）') : t('点击选择颜色')}
        >
          <input
            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
            type="color"
            aria-label={t('{label}选择颜色', { label })}
            value={safeHex}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
        <input
          className={`w-16 text-xs font-medium bg-transparent border-none p-0 focus:ring-0 uppercase focus:outline-none ${
            isNone || isAuto ? 'text-canvas-text-muted font-sans' : 'text-canvas-text font-mono'
          } ${followThemeVar ? 'min-w-0 flex-1' : ''}`}
          type="text"
          value={isAuto || isNone ? '' : value}
          onChange={(e) => {
            const raw = e.target.value;
            if (followThemeVar && (raw.trim() === '' || raw.trim().toLowerCase() === 'auto')) {
              onChange('auto');
            } else if (isTransparentColor(raw) || raw.trim() === '') {
              onChange('transparent');
            } else if (/^#?[0-9a-f]{6}$/i.test(raw.trim())) {
              onChange(raw.trim().startsWith('#') ? raw.trim() : `#${raw.trim()}`);
            } else {
              onChange(raw);
            }
          }}
          placeholder={isAuto ? t('跟随') : isNone ? t('无') : '#HEX'}
          aria-label={t('{label}颜色值', { label })}
        />
        {followThemeVar && (
          <button
            type="button"
            onClick={() => onChange('auto')}
            className={`shrink-0 whitespace-nowrap text-[11px] px-1.5 py-0.5 rounded transition-colors ${isAuto ? 'text-brand-light bg-brand/15' : 'text-canvas-text-muted hover:text-canvas-text hover:bg-canvas-hover'}`}
            aria-label={t('{label}恢复跟随主题', { label })}
            aria-pressed={isAuto}
            title={t('恢复跟随主题配色')}
          >
            {t('跟随')}
          </button>
        )}
        {allowNone && (
          <button
            type="button"
            onClick={() => onChange(isNone ? safeHex : 'transparent')}
            className={`shrink-0 whitespace-nowrap text-[11px] px-1.5 py-0.5 rounded transition-all select-none ${
              isNone
                ? 'bg-brand/15 text-brand-light font-bold ring-1 ring-brand/30'
                : 'text-canvas-text-muted hover:text-canvas-text hover:bg-canvas-hover'
            }`}
            title={isNone ? t('当前已为无，点击恢复颜色') : t('设为无')}
          >
            {t('无')}
          </button>
        )}
      </div>
      )}
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
    <div className="flex min-w-0 flex-wrap items-center gap-2" role="group" aria-label={title}>
      {colors.map((color) => {
        const isSelected = value.toLowerCase() === color.toLowerCase();
        return (
          <button
            key={color}
            type="button"
            aria-pressed={isSelected}
            onClick={() => onChange(color)}
            style={{ backgroundColor: color }}
            className={`w-7 h-7 shrink-0 rounded-md transition-transform ${
              isSelected
                ? 'ring-2 ring-brand ring-offset-2 ring-offset-canvas-card flex items-center justify-center text-white shadow-xs'
                : 'hover:scale-105'
            }`}
            title={color}
          >
            {isSelected && (
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}

type UpdateAppearance = (patch: (theme: AppearanceTheme) => AppearanceTheme) => void;

export function ButtonAppearanceControls({ active, resolved, update, updateImage }: {
  active: AppearanceTheme;
  resolved: AppearanceTheme;
  update: UpdateAppearance;
  updateImage: UpdateAppearance;
}) {
  const t = useT();
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3">
        {([
          { key: 'radius', label: '按钮圆角', max: 24, step: 1, precision: 0 },
          { key: 'borderWidth', label: '按钮边框宽度', max: 3, step: 0.5, precision: 1 },
        ] as const).map(({ key, label, max, step, precision }) => (
          <div key={key} className="p-3 settings-sub-card rounded-xl space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={`appearance-button-${key}`} className="text-xs font-semibold text-canvas-text">{t(label)}</label>
              <NumberStepper
                aria-label={t(label)}
                value={active.ui.button[key]}
                min={0}
                max={max}
                step={step}
                precision={precision}
                unit="px"
                size="sm"
                onChange={(value) => update((theme) => ({ ...theme, ui: { ...theme.ui, button: { ...theme.ui.button, [key]: value } } }))}
              />
            </div>
            <input
              id={`appearance-button-${key}`}
              type="range"
              min={0}
              max={max}
              step={step}
              value={active.ui.button[key]}
              onChange={(event) => update((theme) => ({ ...theme, ui: { ...theme.ui, button: { ...theme.ui.button, [key]: Number(event.target.value) } } }))}
              className="ui-slider w-full"
            />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3 mt-3">
        {([
          { key: 'normal', title: '普通按钮', prefix: '--button' },
          { key: 'primary', title: '主按钮', prefix: '--button-primary' },
        ] as const).map((variant) => {
          const fallback = variant.key === 'normal'
            ? { background: resolved.ui.card, hoverBackground: resolved.ui.hover, text: resolved.ui.text, border: resolved.ui.border }
            : {
              background: resolved.ui.accent,
              hoverBackground: resolved.ui.accentStrong,
              text: contrastColor(resolved.ui.button.primary.background === 'auto' ? resolved.ui.accent : resolved.ui.button.primary.background),
              border: resolved.ui.accent,
            };
          return (
            <div key={variant.key} className="space-y-2">
              <h4 className="text-xs font-semibold text-canvas-text-secondary">{t(variant.title)}</h4>
              {([
                { key: 'background', label: '背景', token: 'bg', allowNone: true },
                { key: 'hoverBackground', label: '悬停背景', token: 'hover-bg', allowNone: true },
                { key: 'text', label: '文字', token: 'text', allowNone: false },
                { key: 'border', label: '边框', token: 'border', allowNone: true },
              ] as const).map((field) => {
                const imageField = field.key === 'background' ? 'backgroundImage'
                  : field.key === 'hoverBackground' ? 'hoverBackgroundImage' : undefined;
                const colors = active.ui.button[variant.key];
                return (
                  <ColorCardInput
                    key={`${active.id}:${field.key}`}
                    label={t('{variant} · {field}', { variant: t(variant.title), field: t(field.label) })}
                    value={active.ui.button[variant.key][field.key]}
                    image={imageField === 'hoverBackgroundImage' ? colors.hoverBackgroundImage ?? colors.backgroundImage : colors.backgroundImage}
                    onImageChange={imageField ? (image) => updateImage((theme) => ({
                      ...theme,
                      ui: { ...theme.ui, button: { ...theme.ui.button, [variant.key]: { ...theme.ui.button[variant.key], [imageField]: image } } },
                    })) : undefined}
                    fallbackColor={fallback[field.key]}
                    followThemeVar={`${variant.prefix}-${field.token}`}
                    allowNone={field.allowNone}
                    onChange={(value) => update((theme) => ({
                      ...theme,
                      ui: { ...theme.ui, button: { ...theme.ui.button, [variant.key]: { ...theme.ui.button[variant.key], [field.key]: value } } },
                    }))}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="p-3 settings-sub-card rounded-xl mt-3 space-y-2">
        <p className="text-xs text-canvas-text-secondary">{t('预览，悬停查看效果；小号和大号按钮圆角按比例调整')}</p>
        <div className="ui-row ui-row--loose">
          <button type="button" className="ui-btn">{t('普通按钮')}</button>
          <button type="button" className="ui-btn ui-btn--secondary">{t('次级按钮')}</button>
          <button type="button" className="ui-btn ui-btn--primary">{t('主按钮')}</button>
          <button type="button" className="ui-btn" disabled>{t('禁用')}</button>
        </div>
      </div>
      <div className="flex justify-end mt-3">
        <button
          type="button"
          className="ui-btn ui-btn--ghost ui-btn--sm"
          onClick={() => update((theme) => ({ ...theme, ui: { ...theme.ui, button: getBuiltinAppearanceTheme('standard-dark').ui.button } }))}
        >
          {t('恢复按钮默认')}
        </button>
      </div>
    </>
  );
}
