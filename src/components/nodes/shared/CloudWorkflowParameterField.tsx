/**
 * CloudWorkflowParameterField — 提供云工作流参数字段界面与交互。
 */
import { useId, useState, type CSSProperties } from 'react';
import {
  cloudWorkflowSliderTicks,
  createCloudWorkflowSliderBounds,
  formatCloudWorkflowSliderValue,
  resolveCloudWorkflowParameterControl,
  resolveCloudWorkflowParameterSpec,
  type CloudWorkflowParameterControlSpec,
} from '../../../services/cloudWorkflowParameterControls';
import Select from '../../shared/Select';
import { useT } from '../../../i18n';

interface CloudWorkflowParameterFieldProps extends CloudWorkflowParameterControlSpec {
  nodeId?: string;
  required?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
  onReset?: () => void;
  defaultValue?: string | number | boolean;
  /** 仅声明式工作流空串表示采用默认值；精确输入仍保持空串。 */
  displayDefaultWhenEmpty?: boolean;
}

const parseNumber = (text: string) => text.trim() === '' ? NaN : Number(text);
const rangeStyle = (progress: number): CSSProperties => ({ '--range-progress': `${Math.min(100, Math.max(0, progress))}%` } as CSSProperties);

/** 分辨率和时长仅通过滑块与刻度编辑，不自动吸附已有值。 */
export default function CloudWorkflowParameterField({
  name, label, nodeId, type, value, options, min, max, step, multiline: declaredMultiline,
  required = false, disabled = false, onChange, onReset, defaultValue, displayDefaultWhenEmpty = false,
}: CloudWorkflowParameterFieldProps) {
  const t = useT();
  const id = useId();
  const labelId = `${id}-label`;
  const accessibleLabel = nodeId ? `${label} · C#${nodeId}` : label;
  const [multiline] = useState(() => declaredMultiline ?? [value, String(defaultValue ?? '')].some((text) => /[\r\n]/.test(text) || text.length > 100));
  const effectiveValue = displayDefaultWhenEmpty && value === '' ? String(defaultValue ?? '') : value;
  const spec = resolveCloudWorkflowParameterSpec({ name, label, type, value: effectiveValue, options, min, max, step, multiline });
  const control = resolveCloudWorkflowParameterControl(spec);
  const isSlider = control.kind === 'options-slider' || control.kind === 'number-slider';
  const knownValue = control.options.some((option) => option.value === effectiveValue);
  const selectionOptions = [
    ...(!knownValue ? [{ value: effectiveValue, label: effectiveValue === '' ? t('未填写') : t('当前值：{value}', { value: effectiveValue }) }] : []),
    ...control.options,
  ];
  const numericValue = parseNumber(effectiveValue);
  const bounds = createCloudWorkflowSliderBounds(spec);
  const validBounds = [bounds.min, bounds.max, bounds.step].every(Number.isFinite) && bounds.step > 0 && bounds.max >= bounds.min;
  const validRange = validBounds && bounds.max > bounds.min;
  const rangeHasValue = validBounds && Number.isFinite(numericValue) && numericValue >= bounds.min && numericValue <= bounds.max;
  const stepIndex = (numericValue - bounds.min) / bounds.step;
  const onSliderStep = rangeHasValue && Number.isFinite(stepIndex) && Math.abs(stepIndex - Math.round(stepIndex)) < 1e-7;
  const numericStep = spec.step !== undefined && Number.isFinite(spec.step) && spec.step > 0 ? spec.step : type === 'integer' ? 1 : 'any';
  const numberInput = () => <input id={id} className="ui-input w-full" type="number" value={value}
    min={spec.min} max={spec.max} step={numericStep} required={required} disabled={disabled}
    placeholder={defaultValue === undefined ? t('未填写') : String(defaultValue)} onChange={(event) => onChange(event.target.value)} />;
  const currentBadge = <output className="ui-badge min-w-0 max-w-full" aria-live="off" title={effectiveValue || t('未填写')}>
    <span className="min-w-0 truncate">{effectiveValue || t('未填写')}</span>
  </output>;
  const discreteTicks = control.sliderOptions.filter((_, index, all) => all.length <= 8
    || Array.from({ length: 8 }, (_, tick) => Math.round(tick * (all.length - 1) / 7)).includes(index));
  const renderScalar = () => {
    if (control.kind === 'number') return numberInput();
    return multiline ? <textarea id={id} className="ui-textarea w-full resize-y" rows={3} value={value}
      required={required} disabled={disabled} placeholder={defaultValue === undefined ? t('未填写') : String(defaultValue)}
      onChange={(event) => onChange(event.target.value)} />
      : <input id={id} className="ui-input w-full" type="text" value={value} required={required} disabled={disabled}
        placeholder={defaultValue === undefined ? t('未填写') : String(defaultValue)} onChange={(event) => onChange(event.target.value)} />;
  };

  return <div className="ui-field min-w-0">
    <div className={`flex min-w-0 items-center justify-between gap-2 ${isSlider ? 'min-h-[var(--ui-control-h-sm)]' : ''}`}>
      <label id={labelId} htmlFor={id} className="img-rp-section-label cloud-workflow-param-label flex min-w-0 flex-1 items-center justify-between gap-2 break-words">
        <span className="min-w-0">{label}{required ? ' *' : ''}</span>
        {nodeId && <code className="ui-badge ui-badge--outline shrink-0 normal-case" title={t('ComfyUI 节点 ID')}>C#{nodeId}</code>}
      </label>
      {(isSlider || onReset) && <div className="flex min-w-0 items-center justify-end gap-2">
        {isSlider && currentBadge}
        {onReset && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm shrink-0" disabled={disabled}
          onClick={onReset} aria-label={`${accessibleLabel}：${defaultValue === undefined ? t('清除') : t('恢复默认')}`}>
          {defaultValue === undefined ? t('清除') : t('恢复默认')}
        </button>}
      </div>}
    </div>
    {control.kind === 'ratio-options' ? <>
      <div className="img-rp-ratio-right min-w-0" role="group" aria-labelledby={labelId}>
        {control.options.map((option) => {
          const parts = option.label.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
          const ratio = parts ? Number(parts[1]) / Number(parts[2]) : 1;
          const width = Number.isFinite(ratio) && ratio > 0 ? 18 * Math.min(1, ratio) : 18;
          const height = Number.isFinite(ratio) && ratio > 0 ? 18 / Math.max(1, ratio) : 18;
          return <button type="button" key={option.value}
            className={`img-rp-ratio-item min-w-0 break-words text-center disabled:cursor-not-allowed disabled:opacity-50 ${effectiveValue === option.value ? 'active' : ''}`}
            title={option.value} aria-pressed={effectiveValue === option.value} disabled={disabled} onClick={() => onChange(option.value)}>
            <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
              <rect x={(24 - width) / 2} y={(24 - height) / 2} width={width} height={height} rx={1.5} />
            </svg>
            <span className="max-w-full">{option.label}</span>
          </button>;
        })}
      </div>
      {!knownValue && <p className="ui-hint break-words">{effectiveValue === '' ? t('未填写') : t('当前值：{value}', { value: effectiveValue })}</p>}
    </> : control.kind === 'segments' ? <>
      <div role="group" aria-labelledby={labelId} className={`img-rp-quality-segmented ${control.semantic === 'ratio' ? 'rh-video-resolution-seg' : 'flex-wrap'}`}>
        {control.options.map((option) => <button type="button" key={option.value}
          className={`img-rp-quality-item min-w-0 break-words text-center disabled:cursor-not-allowed disabled:opacity-50 ${effectiveValue === option.value ? 'active' : ''}`}
          title={option.value} aria-pressed={effectiveValue === option.value} disabled={disabled} onClick={() => onChange(option.value)}>{option.label}</button>)}
      </div>
      {!knownValue && <p className="ui-hint break-words">{effectiveValue === '' ? t('未填写') : t('当前值：{value}', { value: effectiveValue })}</p>}
    </> : control.kind === 'select' ? <Select id={id} className="w-full" fixedMenu aria-label={accessibleLabel}
      required={required} value={effectiveValue} options={selectionOptions} disabled={disabled} onChange={onChange} />
      : control.kind === 'options-slider' ? <div className="rh-duration-slider">
        <input id={id} className="w-full" type="range" min={0} max={Math.max(0, control.sliderOptions.length - 1)} step={1}
          value={Math.max(0, control.currentOptionIndex)} style={rangeStyle(control.currentOptionIndex < 0 || control.sliderOptions.length < 2 ? 0 : control.currentOptionIndex * 100 / (control.sliderOptions.length - 1))}
          disabled={disabled || control.currentOptionIndex < 0 || control.sliderOptions.length < 2} aria-label={t('{label}滑块', { label: accessibleLabel })} aria-valuetext={effectiveValue || t('未填写')}
          onChange={(event) => { const option = control.sliderOptions[Number(event.target.value)]; if (option) onChange(option.value); }} />
        <div className="rh-duration-labels gap-1" role="group" aria-labelledby={labelId}>
          {discreteTicks.map((option) => <button type="button" key={option.value}
            className={`rh-duration-tick truncate disabled:cursor-not-allowed disabled:opacity-50 ${effectiveValue === option.value ? 'active' : ''}`} title={option.label}
            disabled={disabled} aria-pressed={effectiveValue === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}
        </div>
        {control.specialOptions.length > 0 && <div className="flex flex-wrap gap-1" role="group" aria-label={t('{label}特殊选项', { label: accessibleLabel })}>
          {control.specialOptions.map((option) => <button type="button" key={option.value}
            className={`ui-btn ui-btn--sm ${option.value === effectiveValue ? 'ui-btn--primary' : ''}`} disabled={disabled}
            aria-pressed={option.value === effectiveValue} onClick={() => onChange(option.value)}>{option.label}</button>)}
        </div>}
        {control.currentOptionIndex < 0 && <p className="ui-hint">{t('选择档位后可拖动调整。')}</p>}
      </div>
        : control.kind === 'number-slider' ? <div className="rh-duration-slider">
          <input id={id} className="w-full" type="range" min={Number.isFinite(bounds.min) ? bounds.min : 0} max={validBounds ? bounds.max : Number.isFinite(bounds.min) ? bounds.min : 0}
            step={rangeHasValue && !onSliderStep ? 'any' : Number.isFinite(bounds.step) && bounds.step > 0 ? bounds.step : 1} value={rangeHasValue ? numericValue : Number.isFinite(bounds.min) ? bounds.min : 0}
            style={rangeStyle(rangeHasValue && validRange ? (numericValue - bounds.min) / (bounds.max - bounds.min) * 100 : 0)} disabled={disabled || !validRange || !onSliderStep}
            aria-label={t('{label}滑块', { label: accessibleLabel })} aria-valuetext={effectiveValue || t('未填写')}
            onChange={(event) => onChange(formatCloudWorkflowSliderValue(Number(event.target.value), bounds.precision))} />
          {validBounds && <div className="rh-duration-labels gap-1" role="group" aria-labelledby={labelId}>
            {cloudWorkflowSliderTicks(bounds).map((tick) => <button type="button" key={tick} disabled={disabled}
              className={`rh-duration-tick truncate disabled:cursor-not-allowed disabled:opacity-50 ${tick === effectiveValue ? 'active' : ''}`}
              aria-pressed={tick === effectiveValue} onClick={() => onChange(tick)}>{tick}</button>)}
          </div>}
          {!rangeHasValue && <p className="ui-hint break-words">{!validBounds ? t('当前参数范围不可用，请核对工作流定义。')
            : effectiveValue === '' ? t('未填写；请选择刻度设置。')
              : t('当前值 {value} 不在滑块范围 {min}–{max}，原值保留，可选择刻度调整。', { value: effectiveValue, min: bounds.min, max: bounds.max })}</p>}
          {rangeHasValue && !onSliderStep && <p className="ui-hint">{t('原值保留；选择刻度后可拖动调整。')}</p>}
        </div> : renderScalar()}
  </div>;
}
