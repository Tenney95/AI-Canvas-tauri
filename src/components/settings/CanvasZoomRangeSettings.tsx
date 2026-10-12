import { useId } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useT } from '../../i18n';
import { getCanvasZoomRange, MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM } from '../../utils/canvasViewportPreferences';
import NumberStepper from '../shared/NumberStepper';

export default function CanvasZoomRangeSettings({ onPersist }: { onPersist: () => Promise<boolean> }) {
  const t = useT();
  const titleId = useId();
  const minId = useId();
  const maxId = useId();
  const hydrated = useAppStore((state) => state.configHydrated);
  const minZoom = useAppStore((state) => getCanvasZoomRange(state.config).minZoom);
  const maxZoom = useAppStore((state) => getCanvasZoomRange(state.config).maxZoom);
  const updateConfig = useAppStore((state) => state.updateConfig);
  const minPercent = Math.round(minZoom * 100);
  const maxPercent = Math.round(maxZoom * 100);

  const changeRange = (nextMin: number, nextMax: number) => {
    if (!hydrated) return;
    updateConfig({ canvasViewportMinZoom: nextMin, canvasViewportMaxZoom: nextMax });
    void onPersist();
  };

  return (
    <section className="ui-card p-3 gap-3" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id={titleId} className="ui-title">{t('画布缩放范围')}</h3>
          <p className="ui-hint">{t('自动适配、滚轮和快捷键均在此范围内缩放，修改后即时生效。')}</p>
        </div>
        <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost"
          disabled={!hydrated || (minZoom === MIN_CANVAS_ZOOM && maxZoom === MAX_CANVAS_ZOOM)}
          onClick={() => changeRange(MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM)}>
          {t('恢复默认范围')}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="ui-field">
          <label className="ui-label" htmlFor={minId}>{t('最小缩放比例')}</label>
          <NumberStepper id={minId} value={minPercent} min={MIN_CANVAS_ZOOM * 100} max={maxPercent}
            step={1} unit="%" disabled={!hydrated} aria-label={t('最小缩放比例')}
            onChange={(value) => changeRange(value / 100, maxZoom)} />
        </div>
        <div className="ui-field">
          <label className="ui-label" htmlFor={maxId}>{t('最大缩放比例')}</label>
          <NumberStepper id={maxId} value={maxPercent} min={minPercent} max={MAX_CANVAS_ZOOM * 100}
            step={1} unit="%" disabled={!hydrated} aria-label={t('最大缩放比例')}
            onChange={(value) => changeRange(minZoom, value / 100)} />
        </div>
      </div>
      <p className="ui-hint">{t('可设置 10%～500%，例如 50%～60%；两端相同则固定为该比例。')}</p>
    </section>
  );
}
