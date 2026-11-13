/**
 * QualityRatioSelector — 图像分辨率、生成质量和宽高比选择器
 */
import { useState, useRef, useEffect, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import AnimatedButton from '../../shared/AnimatedButton';
import { useT } from '../../../i18n';
import { bindDialogFocus } from '../../../hooks/useDialogFocus';
import { calcAnchoredPosition } from '../../../utils/popupPosition';

interface RatioOption {
  value: string;
  className: string;
}

interface QualityRatioSelectorProps {
  disabled?: boolean;
  /** 滚动弹窗中挂到视口，避免父容器裁切。 */
  fixedMenu?: boolean;
  imageSize?: string;
  imageQuality?: string;
  imageQualities?: readonly string[];
  defaultImageQuality?: string;
  imageBackground?: string;
  imageBackgrounds?: readonly string[];
  defaultImageBackground?: string;
  imageBackgroundIsFixed?: boolean;
  aspectRatio?: string;
  onChangeImageSize?: (size: string) => void;
  onChangeImageQuality?: (quality: string | undefined) => void;
  onChangeImageBackground?: (background: string | undefined) => void;
  onChangeAspectRatio: (ratio: string) => void;
  /** 是否显示分辨率选择区，默认 true */
  showImageSize?: boolean;
  /** 是否显示"自适应"选项，默认 true */
  showAdaptive?: boolean;
  /** 自定义比例选项列表，不传则使用默认 */
  ratios?: readonly (RatioOption | string)[];
  /** 自定义分辨率档位，不传则使用通用档位 */
  imageSizes?: readonly string[];
  /** 弹出方向：'top'(默认，向上，适合底部工具栏) | 'bottom'(向下，适合顶部工具栏) */
  placement?: 'top' | 'bottom';
}

export default function QualityRatioSelector({
  disabled = false,
  fixedMenu = false,
  imageSize = '1K',
  imageQuality,
  imageQualities,
  defaultImageQuality,
  imageBackground,
  imageBackgrounds,
  defaultImageBackground,
  imageBackgroundIsFixed,
  aspectRatio = '16:9',
  onChangeImageSize,
  onChangeImageQuality,
  onChangeImageBackground,
  onChangeAspectRatio,
  showImageSize = true,
  showAdaptive = true,
  ratios: customRatios,
  imageSizes = ['720p', '1K', '2K', '4K'],
  placement = 'top',
}: QualityRatioSelectorProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (disabled && open) setOpen(false);
  const ref = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || disabled || !fixedMenu) return;
    const trigger = ref.current?.querySelector<HTMLButtonElement>('.ui-schema-menu-trigger');
    const popup = popupRef.current;
    if (!trigger || !popup) return;
    let layer = 300;
    for (let parent: HTMLElement | null = ref.current; parent; parent = parent.parentElement) {
      const value = Number.parseInt(window.getComputedStyle(parent).zIndex, 10);
      if (Number.isFinite(value)) layer = Math.max(layer, value + 1);
    }
    const update = () => {
      const rect = trigger.getBoundingClientRect();
      popup.style.position = 'fixed';
      popup.style.bottom = 'auto';
      popup.style.right = 'auto';
      popup.style.margin = '0';
      popup.style.zIndex = String(layer);
      popup.style.maxHeight = `${Math.max(0, Math.max(rect.top, window.innerHeight - rect.bottom) - 14)}px`;
      const position = calcAnchoredPosition(rect, popup.offsetWidth, popup.offsetHeight, 6);
      popup.style.left = `${position.left}px`;
      popup.style.top = `${position.top}px`;
      popup.style.transformOrigin = position.placement === 'above' ? 'bottom left' : 'top left';
    };
    update();
    const unbindFocus = bindDialogFocus(popup, () => setOpen(false), { zIndex: layer });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(popup);
    observer?.observe(trigger);
    window.addEventListener('resize', update);
    document.addEventListener('scroll', update, true);
    return () => {
      unbindFocus();
      observer?.disconnect();
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', update, true);
    };
  }, [open, disabled, fixedMenu]);

  // Close popup on outside click (capture phase to beat React Flow event interception)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !popupRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handler, true);
    }
    return () => document.removeEventListener('mousedown', handler, true);
  }, [open]);

  // Close popup on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    if (open) {
      window.addEventListener('keydown', handler);
    }
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  const DEFAULT_RATIOS: RatioOption[] = [
    { value: '1:1', className: 'img-rp-sq' },
    { value: '9:16', className: 'img-rp-tall' },
    { value: '16:9', className: 'img-rp-wide' },
    { value: '3:4', className: 'img-rp-p34' },
    { value: '4:3', className: 'img-rp-l43' },
    { value: '3:2', className: 'img-rp-l32' },
    { value: '2:3', className: 'img-rp-p23' },
    { value: '5:4', className: 'img-rp-l54' },
    { value: '4:5', className: 'img-rp-p45' },
    { value: '21:9', className: 'img-rp-ultra' },
    { value: '1:4', className: 'img-rp-p14' },
    { value: '4:1', className: 'img-rp-l41' },
    { value: '1:6', className: 'img-rp-p16' },
    { value: '6:1', className: 'img-rp-l61' },
    { value: '1:8', className: 'img-rp-p18' },
    { value: '8:1', className: 'img-rp-l81' },
  ];

  const ratios = customRatios?.map((ratio) => {
    if (typeof ratio !== 'string') return ratio;
    const known = DEFAULT_RATIOS.find((option) => option.value === ratio);
    const [width, height] = ratio.split(':').map(Number);
    return known ?? { value: ratio, className: width === height ? 'img-rp-sq'
      : width >= height * 2 ? 'img-rp-ultra' : width > height ? 'img-rp-wide' : 'img-rp-tall' };
  }) ?? DEFAULT_RATIOS;
  const selectedQuality = imageQualities?.find((quality) => quality.toLowerCase() === imageQuality?.toLowerCase())
    ?? imageQualities?.find((quality) => quality.toLowerCase() === defaultImageQuality?.toLowerCase());
  const backgroundDefault = imageBackgrounds?.find((background) => background.toLowerCase() === defaultImageBackground?.toLowerCase());
  const fixedBackground = imageBackgroundIsFixed === true && backgroundDefault !== undefined;
  const selectedBackground = fixedBackground ? backgroundDefault : imageBackground === '' ? undefined
    : imageBackgrounds?.find((background) => background.toLowerCase() === imageBackground?.toLowerCase()) ?? backgroundDefault;
  const backgroundLabels: Record<string, string> = { auto: t('自动'), transparent: t('透明'), opaque: t('不透明') };
  const backgroundSummaries: Record<string, string> = { auto: t('自动背景'), transparent: t('透明背景'), opaque: t('不透明背景') };
  const summary = [aspectRatio, showImageSize ? imageSize : undefined, selectedQuality,
    selectedBackground ? backgroundSummaries[selectedBackground] ?? selectedBackground : undefined].filter(Boolean).join(' · ');
  const renderPopup = (content: ReactNode) => fixedMenu ? createPortal(content, document.body) : content;

  return (
    <div className="ui-schema-renderer" data-ui-schema-model="apimart/gemini-3.1-flash-image-preview" data-ui-schema-placement="resolution" ref={ref}>
      <div className="ui-schema-quality-ratio-pill" data-ui-schema-composite-field="qualityRatio">
        <AnimatedButton
          type="button"
          className="img-pill-btn ui-schema-menu-trigger"
          data-ui-schema-menu-trigger="qualityRatio"
          disabled={disabled}
          aria-label={summary}
          aria-expanded={open && !disabled}
          title={summary}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18" />
            <path d="M9 21V9" />
          </svg>
          <span className="ui-schema-pill-label ui-schema-quality-ratio-label">
            {summary}
          </span>
        </AnimatedButton>

        {open && !disabled && renderPopup(
          <div ref={popupRef} role={fixedMenu ? 'dialog' : undefined} aria-label={fixedMenu ? summary : undefined} tabIndex={-1}
            className={`img-ratio-popup ui-schema-popup ui-schema-quality-ratio-popup${placement === 'bottom' ? ' img-ratio-popup--down' : ''}`}>
            {showImageSize && (
              <div className="img-rp-quality-area" data-ui-schema-field="imageSize" data-ui-schema-type="segmented" data-ui-schema-default="2K">
                <div className="img-rp-section-label">{t('分辨率')}</div>
                <div className="ui-segmented ui-segmented--brand" role="group" aria-label={t('分辨率')}>
                  {imageSizes.map((size) => (
                    <AnimatedButton
                      key={size}
                      type="button"
                      className={`ui-segmented__item ui-schema-option${imageSize.toLowerCase() === size.toLowerCase() ? ' is-active' : ''}`}
                      aria-pressed={imageSize.toLowerCase() === size.toLowerCase()}
                      data-ui-schema-value={size}
                      data-ui-schema-option-label={size}
                      onClick={() => onChangeImageSize?.(size)}
                    >
                      {size}
                    </AnimatedButton>
                  ))}
                </div>
              </div>
            )}

            {!!imageQualities?.length && (
              <div data-ui-schema-field="imageQuality" data-ui-schema-type="segmented" data-ui-schema-default={defaultImageQuality}>
                <div className="img-rp-section-label">{t('生成质量')}</div>
                <div className="ui-segmented ui-segmented--brand" role="group" aria-label={t('生成质量')}>
                  {imageQualities.map((quality) => (
                    <AnimatedButton
                      key={quality}
                      type="button"
                      className={`ui-segmented__item ui-schema-option${selectedQuality === quality ? ' is-active' : ''}`}
                      aria-pressed={selectedQuality === quality}
                      data-ui-schema-value={quality}
                      data-ui-schema-option-label={quality}
                      onClick={() => onChangeImageQuality?.(quality)}
                    >
                      {quality}
                    </AnimatedButton>
                  ))}
                </div>
              </div>
            )}

            {!!imageBackgrounds?.length && (
              <div data-ui-schema-field="imageBackground" data-ui-schema-type="segmented" data-ui-schema-default={defaultImageBackground}>
                <div className="img-rp-section-label">{t('生成背景')}</div>
                <div className="ui-segmented ui-segmented--brand" role="group" aria-label={t('生成背景')}>
                  {(!fixedBackground ? ['', ...imageBackgrounds] : imageBackgrounds).map((background) => (
                    <AnimatedButton
                      key={background}
                      type="button"
                      className={`ui-segmented__item ui-schema-option${(selectedBackground ?? '') === background ? ' is-active' : ''}`}
                      aria-pressed={(selectedBackground ?? '') === background}
                      data-ui-schema-value={background}
                      data-ui-schema-option-label={background ? backgroundLabels[background] ?? background : t('接口默认')}
                      onClick={() => onChangeImageBackground?.(background)}
                    >
                      {background ? backgroundLabels[background] ?? background : t('接口默认')}
                    </AnimatedButton>
                  ))}
                </div>
              </div>
            )}

            <div className="img-rp-ratio-area" data-ui-schema-field="aspectRatio" data-ui-schema-type="segmented" data-ui-schema-default={showAdaptive ? '自适应' : '16:9'}>
              <div className="img-rp-section-label">{t('比例')}</div>
              <div className={`img-rp-ratio-split${showAdaptive ? ' has-adaptive' : ''}`}>
                {showAdaptive && (
                  <div className="img-rp-ratio-left">
                    <AnimatedButton
                      type="button"
                      className={`img-rp-large-adaptive ui-schema-option ${aspectRatio === '自适应' ? 'active' : ''}`}
                      data-label="自适应"
                      data-ui-schema-value="自适应"
                      onClick={() => onChangeAspectRatio('自适应')}
                    >
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <path d="M3 9h18" />
                        <path d="M9 21V9" />
                      </svg>
                      <span>{t('自适应')}</span>
                    </AnimatedButton>
                  </div>
                )}
                <div className="img-rp-ratio-right">
                  {ratios.map((r) => (
                    <AnimatedButton
                      key={r.value}
                      type="button"
                      className={`img-rp-ratio-item ui-schema-option ${aspectRatio === r.value ? 'active' : ''}`}
                      data-label={r.value}
                      data-ui-schema-value={r.value}
                      onClick={() => onChangeAspectRatio(r.value)}
                    >
                      <span className={`img-rp-icon ${r.className}`}></span>
                      <span>{r.value}</span>
                    </AnimatedButton>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
