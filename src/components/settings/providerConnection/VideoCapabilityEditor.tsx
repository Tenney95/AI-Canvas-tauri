/**
 * settings/providerConnection/VideoCapabilityEditor — 视频模型的固定能力编辑器。
 *
 * 这里勾选的值会直接约束画布上视频节点的可选项，所以编辑器只做「声明」：
 * 未填写的字段一律保持 undefined，绝不替用户猜测默认值。
 */
import { useT } from '../../../i18n';

import Select from '../../shared/Select';
import NumberStepper from '../../shared/NumberStepper';
import { Icon } from '@iconify/react';
import { useId, useState } from 'react';
import type { ProviderModelSelection } from '../../../types';
import type { NumericInputConstraint, VideoInputConstraints, VideoModelCapability } from '../../../types/aiTypes';
import {
  SEEDANCE_QUICK_ADAPT_OPTIONS,
  type SeedanceModelVariant,
  type SeedanceQuickAdaptTransport,
} from '../../../services/ai/seedanceModelCapabilities';
import {
  H3_QUICK_ADAPT_OPTIONS,
  type H3ModelVariant,
  type H3QuickAdaptTransport,
} from '../../../services/ai/h3ModelCapabilities';
import PopupCloseButton from '../../shared/PopupCloseButton';
import {
  VIDEO_DURATION_PRESETS,
  VIDEO_DURATION_RANGE_MAX,
  VIDEO_DURATION_RANGE_MIN,
  VIDEO_FRAME_RATE_PRESETS,
  VIDEO_RATIO_PRESETS,
  VIDEO_RESOLUTION_PRESETS,
} from './providerConnectionShared';
import {
  createEditableVideoCapability,
  keepDeclaredVideoCapabilityDefault,
} from './providerConnectionModels';

interface VideoCapabilityEditorProps {
  model: ProviderModelSelection;
  onChange: (capability: VideoModelCapability | undefined) => void;
  onApplySeedanceTemplate: (
    model: SeedanceModelVariant,
    transport: SeedanceQuickAdaptTransport,
  ) => void;
  onApplyH3Template: (
    model: H3ModelVariant,
    transport: H3QuickAdaptTransport,
  ) => void;
  onClose: () => void;
}

function optionalNumber(value: string, options: { integer?: boolean; scale?: number } = {}): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  const scaled = parsed * (options.scale ?? 1);
  return options.integer ? Math.round(scaled) : scaled;
}

export default function VideoCapabilityEditor({
  model,
  onChange,
  onApplySeedanceTemplate,
  onApplyH3Template,
  onClose,
}: VideoCapabilityEditorProps) {
  const t = useT();
  const [customRatio, setCustomRatio] = useState('');
  const durationInputId = useId();
  const [customResolution, setCustomResolution] = useState('');
  const [customFrameRate, setCustomFrameRate] = useState('');
  const [customDuration, setCustomDuration] = useState('');
  const [durationDragScale, setDurationDragScale] = useState<{ min: number; max: number }>();
  const [seedanceTemplateId, setSeedanceTemplateId] = useState('2.5:volcengine');
  const [h3TemplateId, setH3TemplateId] = useState('h3-standard:minimax');
  const capability = createEditableVideoCapability(model.videoCapability);
  const discreteDurations = capability.durations?.length
    ? [...capability.durations].sort((left, right) => left - right)
    : undefined;
  const ratioOptions = [...new Set([...VIDEO_RATIO_PRESETS, ...(capability.ratios ?? [])])];
  const resolutionOptions = [...new Set([
    ...VIDEO_RESOLUTION_PRESETS,
    ...(capability.resolutions ?? []),
  ])];
  const frameRateOptions = [...new Set([
    ...VIDEO_FRAME_RATE_PRESETS,
    ...(capability.frameRates ?? []),
  ])].sort((left, right) => left - right);
  const durationOptions = [...new Set([
    ...VIDEO_DURATION_PRESETS,
    ...(discreteDurations ?? []),
  ])].sort((left, right) => left - right);
  const inputConstraints = capability.inputConstraints ?? {};
  const declaredMinDuration = capability.minDuration ?? discreteDurations?.[0];
  const declaredMaxDuration = capability.maxDuration ?? discreteDurations?.at(-1);
  const editorMinDuration = Math.min(
    VIDEO_DURATION_RANGE_MAX,
    Math.max(
      VIDEO_DURATION_RANGE_MIN,
      declaredMinDuration ?? Math.min(2, declaredMaxDuration ?? 2),
    ),
  );
  const editorMaxDuration = Math.max(
    editorMinDuration,
    Math.min(
      VIDEO_DURATION_RANGE_MAX,
      declaredMaxDuration ?? 15,
    ),
  );
  // 输入上限不是滑轨刻度；常用秒数不能被 1–3600 秒的完整范围挤到一起。
  const sliderMinDuration = durationDragScale?.min ?? Math.min(2, editorMinDuration);
  const sliderMaxDuration = durationDragScale?.max ?? Math.max(30, editorMaxDuration);
  const sliderDurationSpan = sliderMaxDuration - sliderMinDuration;
  const minimumThumbOnTop = editorMinDuration > (sliderMinDuration + sliderMaxDuration) / 2;

  const commit = (next: VideoModelCapability) => onChange(createEditableVideoCapability(next));
  const changeDurationEndpoint = (endpoint: 'min' | 'max', rawValue: string): number => {
    const previous = endpoint === 'min' ? editorMinDuration : editorMaxDuration;
    const parsed = Number(rawValue);
    if (!rawValue.trim() || !Number.isInteger(parsed)
      || parsed < VIDEO_DURATION_RANGE_MIN || parsed > VIDEO_DURATION_RANGE_MAX) return previous;
    const value = endpoint === 'min'
      ? Math.min(parsed, editorMaxDuration)
      : Math.max(parsed, editorMinDuration);
    if (value === previous) return value;
    commit({
      ...capability,
      [endpoint === 'min' ? 'minDuration' : 'maxDuration']: value,
      ...(capability.defaultDuration === undefined ? {} : {
        defaultDuration: endpoint === 'min'
          ? Math.max(value, capability.defaultDuration)
          : Math.min(value, capability.defaultDuration),
      }),
    });
    return value;
  };
  const commitInputConstraints = (next: VideoInputConstraints) => commit({
    ...capability,
    inputConstraints: next,
  });
  const commitReferenceDuration = <Field extends 'min' | 'max' | 'maxExclusive'>(
    reference: 'referenceVideo' | 'referenceAudio',
    field: Field,
    value: NumericInputConstraint[Field],
  ) => commitInputConstraints({
    ...inputConstraints,
    [reference]: {
      ...inputConstraints[reference],
      durationSeconds: {
        ...inputConstraints[reference]?.durationSeconds,
        [field]: value,
      },
    },
  });
  const toggleStringOption = (
    field: 'ratios' | 'resolutions',
    defaultField: 'defaultRatio' | 'defaultResolution',
    value: string,
  ) => {
    const current = capability[field] ?? [];
    if (current.includes(value) && current.length === 1) return;
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value];
    commit({
      ...capability,
      [field]: next,
      [defaultField]: keepDeclaredVideoCapabilityDefault(
        capability[defaultField] as string | undefined,
        next,
      ),
    });
  };
  const addStringOption = (
    field: 'ratios' | 'resolutions',
    defaultField: 'defaultRatio' | 'defaultResolution',
    rawValue: string,
    clear: () => void,
  ) => {
    const value = rawValue.trim();
    if (!value) return;
    const current = capability[field] ?? [];
    commit({
      ...capability,
      [field]: current.includes(value) ? current : [...current, value],
      [defaultField]: capability[defaultField],
    });
    clear();
  };
  const toggleFrameRate = (value: number) => {
    const current = capability.frameRates ?? [];
    if (current.includes(value) && current.length === 1) return;
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value].sort((left, right) => left - right);
    commit({
      ...capability,
      frameRates: next,
      defaultFrameRate: keepDeclaredVideoCapabilityDefault(capability.defaultFrameRate, next),
    });
  };
  const toggleDuration = (value: number) => {
    const current = discreteDurations ?? [];
    if (current.includes(value) && current.length === 1) return;
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value].sort((left, right) => left - right);
    commit({
      ...capability,
      durations: next,
      ...(capability.minDuration === undefined ? {} : { minDuration: Math.min(...next) }),
      ...(capability.maxDuration === undefined ? {} : { maxDuration: Math.max(...next) }),
      defaultDuration: keepDeclaredVideoCapabilityDefault(capability.defaultDuration, next),
    });
  };
  const optionClass = (active: boolean) => `ui-chip min-h-7 ${active ? 'is-active' : ''}`;

  return (
    <div className="mt-3 rounded-xl border border-canvas-border bg-canvas-surface/80 p-4 shadow-xl shadow-black/10">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-canvas-text">
            <Icon icon="lucide:video" width="17" className="text-indigo-300" />
            {t("视频参数能力")}
          </div>
          <p className="mt-1 text-[11px] leading-5 text-canvas-text-secondary">
            {model.name} {t("· 勾选模型实际支持的值，视频节点只会展示这些选项。")}
          </p>
        </div>
        <PopupCloseButton aria-label={t("关闭视频参数能力")} onClick={onClose} />
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <section className="ui-card min-w-0 p-2">
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 space-y-1 text-[10px] text-canvas-text-secondary">
                <span className="font-medium text-canvas-text">{t("Seedance 快速适配")}</span>
                <Select
                  fixedMenu
                  className="w-full"
                  size="sm"
                  value={seedanceTemplateId}
                  onChange={setSeedanceTemplateId}
                >
                  {SEEDANCE_QUICK_ADAPT_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </Select>
              </label>
              <button
                type="button"
                className="ui-btn ui-btn--secondary ui-btn--sm shrink-0"
                onClick={() => {
                  const [seedanceModel, transport] = seedanceTemplateId.split(':') as [
                    SeedanceModelVariant,
                    SeedanceQuickAdaptTransport,
                  ];
                  onApplySeedanceTemplate(seedanceModel, transport);
                }}
              >
                {t("应用模板")}
              </button>
            </div>
            <p className="mt-1 text-[10px] leading-4 text-canvas-text-muted">
              {t("会同时覆盖当前模型的视频能力与提交/轮询协议。不会根据模型名称自动猜测；应用后仍可继续手动调整。")}
            </p>
          </section>

          <section className="ui-card min-w-0 p-2">
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 space-y-1 text-[10px] text-canvas-text-secondary">
                <span className="font-medium text-canvas-text">{t("MiniMax H3 快速适配")}</span>
                <Select
                  fixedMenu
                  className="w-full"
                  size="sm"
                  value={h3TemplateId}
                  onChange={setH3TemplateId}
                >
                  {H3_QUICK_ADAPT_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </Select>
              </label>
              <button
                type="button"
                className="ui-btn ui-btn--secondary ui-btn--sm shrink-0"
                onClick={() => {
                  const [h3Model, transport] = h3TemplateId.split(':') as [
                    H3ModelVariant,
                    H3QuickAdaptTransport,
                  ];
                  onApplyH3Template(h3Model, transport);
                }}
              >
                {t("应用模板")}
              </button>
            </div>
            <p className="mt-1 text-[10px] leading-4 text-canvas-text-muted">
              {t("支持 MiniMax 官方、APIMart 和 AI Ping。Context-IR 与 Regeneration 不属于普通视频生成模板。")}
            </p>
          </section>
        </div>

        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-canvas-text">{t("画面比例（可多选）")}</span>
            <label className="flex items-center gap-2 text-[10px] text-canvas-text-secondary">
              {t("默认")}
              <Select fixedMenu
                className="min-w-0" size="sm"
                value={capability.defaultRatio ?? ''}
                onChange={(selectedOptionValue) => commit({
                  ...capability,
                  defaultRatio: selectedOptionValue || undefined,
                })}
              >
                <option value="">{t("模型默认（未声明）")}</option>
                {capability.ratios?.map((value) => <option key={value}>{value}</option>)}
              </Select>
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ratioOptions.map((value) => (
              <button key={value} type="button" aria-pressed={capability.ratios?.includes(value)} className={optionClass(capability.ratios?.includes(value) ?? false)} onClick={() => toggleStringOption('ratios', 'defaultRatio', value)}>
                {value === 'adaptive' ? t('自适应') : value}
              </button>
            ))}
            <span className="flex min-h-7 overflow-hidden rounded-md border border-dashed border-canvas-border focus-within:border-indigo-400/60">
              <input className="w-20 bg-transparent px-2 text-[11px] text-canvas-text outline-none" value={customRatio} placeholder={t("自定义")} onChange={(event) => setCustomRatio(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addStringOption('ratios', 'defaultRatio', customRatio, () => setCustomRatio('')); }} />
              <button type="button" className="border-l border-canvas-border px-2 text-indigo-300" aria-label={t("添加自定义比例")} onClick={() => addStringOption('ratios', 'defaultRatio', customRatio, () => setCustomRatio(''))}>+</button>
            </span>
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-canvas-text">{t("分辨率（可多选）")}</span>
            <label className="flex items-center gap-2 text-[10px] text-canvas-text-secondary">
              {t("默认")}
              <Select fixedMenu className="min-w-0" size="sm" value={capability.defaultResolution ?? ''} onChange={(selectedOptionValue) => commit({ ...capability, defaultResolution: selectedOptionValue || undefined })}>
                <option value="">{t("模型默认（未声明）")}</option>
                {capability.resolutions?.map((value) => <option key={value}>{value}</option>)}
              </Select>
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {resolutionOptions.map((value) => (
              <button key={value} type="button" aria-pressed={capability.resolutions?.includes(value)} className={optionClass(capability.resolutions?.includes(value) ?? false)} onClick={() => toggleStringOption('resolutions', 'defaultResolution', value)}>{value}</button>
            ))}
            <span className="flex min-h-7 overflow-hidden rounded-md border border-dashed border-canvas-border focus-within:border-indigo-400/60">
              <input className="w-20 bg-transparent px-2 text-[11px] text-canvas-text outline-none" value={customResolution} placeholder={t("自定义")} onChange={(event) => setCustomResolution(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addStringOption('resolutions', 'defaultResolution', customResolution, () => setCustomResolution('')); }} />
              <button type="button" className="border-l border-canvas-border px-2 text-indigo-300" aria-label={t("添加自定义分辨率")} onClick={() => addStringOption('resolutions', 'defaultResolution', customResolution, () => setCustomResolution(''))}>+</button>
            </span>
          </div>
          <p className="mt-1.5 text-[10px] text-canvas-text-muted">{t("同时提供 480p/1080p 等接口档位和 480/832 等长边像素；请按厂商文档勾选。")}</p>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-canvas-text">{t("帧率（可多选）")}</span>
            <label className="flex items-center gap-2 text-[10px] text-canvas-text-secondary">
              {t("默认")}
              <Select fixedMenu className="min-w-0" size="sm" value={capability.defaultFrameRate ?? ''} onChange={(selectedOptionValue) => commit({ ...capability, defaultFrameRate: selectedOptionValue ? Number(selectedOptionValue) : undefined })}>
                <option value="">{t("模型默认（未声明）")}</option>
                {capability.frameRates?.map((value) => <option key={value} value={value}>{value} FPS</option>)}
              </Select>
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {frameRateOptions.map((value) => (
              <button key={value} type="button" aria-pressed={capability.frameRates?.includes(value)} className={optionClass(capability.frameRates?.includes(value) ?? false)} onClick={() => toggleFrameRate(value)}>{value} FPS</button>
            ))}
            <span className="flex min-h-7 overflow-hidden rounded-md border border-dashed border-canvas-border focus-within:border-indigo-400/60">
              <input type="number" min="1" max="240" className="w-20 bg-transparent px-2 text-[11px] text-canvas-text outline-none" value={customFrameRate} placeholder={t("自定义")} onChange={(event) => setCustomFrameRate(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { const value = Number(customFrameRate); if (Number.isInteger(value) && value > 0 && value <= 240) { if (!capability.frameRates?.includes(value)) toggleFrameRate(value); setCustomFrameRate(''); } } }} />
              <button type="button" className="border-l border-canvas-border px-2 text-indigo-300" aria-label={t("添加自定义帧率")} onClick={() => { const value = Number(customFrameRate); if (Number.isInteger(value) && value > 0 && value <= 240) { if (!capability.frameRates?.includes(value)) toggleFrameRate(value); setCustomFrameRate(''); } }}>+</button>
            </span>
          </div>
        </section>

        <section className="rounded-lg border border-canvas-border bg-canvas-card p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs font-medium text-canvas-text">{t("生成时长")}</span>
            <div className="ui-segmented border border-canvas-border" role="group" aria-label={t("时长模式")}>
              <button type="button" aria-pressed={!discreteDurations} className={`ui-segmented__item ${!discreteDurations ? 'is-active' : ''}`} onClick={() => commit({ ...capability, durations: undefined, minDuration: editorMinDuration, maxDuration: editorMaxDuration })}>{t("连续范围")}</button>
              <button type="button" aria-pressed={!!discreteDurations} className={`ui-segmented__item ${discreteDurations ? 'is-active' : ''}`} onClick={() => commit({ ...capability, durations: [capability.defaultDuration ?? 5] })}>{t("固定档位")}</button>
            </div>
          </div>
          {discreteDurations ? (
            <div className="flex flex-wrap gap-1.5">
              {durationOptions.map((value) => (
                <button key={value} type="button" aria-pressed={discreteDurations.includes(value)} className={optionClass(discreteDurations.includes(value))} onClick={() => toggleDuration(value)}>{value}s</button>
              ))}
              <span className="flex min-h-7 overflow-hidden rounded-md border border-dashed border-canvas-border focus-within:border-indigo-400/60">
                <input type="number" min={VIDEO_DURATION_RANGE_MIN} max={VIDEO_DURATION_RANGE_MAX} className="w-20 bg-transparent px-2 text-[11px] text-canvas-text outline-none" value={customDuration} placeholder={t("自定义秒")} onChange={(event) => setCustomDuration(event.target.value)} />
                <button type="button" className="border-l border-canvas-border px-2 text-indigo-300" aria-label={t("添加自定义时长")} onClick={() => { const value = Number(customDuration); if (Number.isInteger(value) && value >= VIDEO_DURATION_RANGE_MIN && value <= VIDEO_DURATION_RANGE_MAX) { if (!discreteDurations.includes(value)) toggleDuration(value); setCustomDuration(''); } }}>+</button>
              </span>
              <label className="ml-auto flex items-center gap-2 text-[10px] text-canvas-text-secondary">
                {t("默认")}
                <Select fixedMenu className="min-w-0" size="sm" value={capability.defaultDuration ?? ''} onChange={(selectedOptionValue) => commit({ ...capability, defaultDuration: selectedOptionValue ? Number(selectedOptionValue) : undefined })}>
                  <option value="">{t("模型默认（未声明）")}</option>
                  {discreteDurations.map((value) => <option key={value} value={value}>{value}s</option>)}
                </Select>
              </label>
            </div>
          ) : (
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] font-medium text-canvas-text">
                <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
                  <label htmlFor={`${durationInputId}-min`}>{t("最短")}</label>
                  <NumberStepper
                    id={`${durationInputId}-min`}
                    size="sm"
                    unit="s"
                    value={editorMinDuration}
                    min={VIDEO_DURATION_RANGE_MIN}
                    max={editorMaxDuration}
                    step={1}
                    aria-label={t("最短生成时长（秒）")}
                    className={editorMinDuration < 100 ? '[&_.ui-stepper__input]:max-w-[2ch]' : undefined}
                    onChange={(value) => changeDurationEndpoint('min', String(value))}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
                  <label htmlFor={`${durationInputId}-max`}>{t("最长")}</label>
                  <NumberStepper
                    id={`${durationInputId}-max`}
                    size="sm"
                    unit="s"
                    value={editorMaxDuration}
                    min={editorMinDuration}
                    max={VIDEO_DURATION_RANGE_MAX}
                    step={1}
                    aria-label={t("最长生成时长（秒）")}
                    className={editorMaxDuration < 100 ? '[&_.ui-stepper__input]:max-w-[2ch]' : undefined}
                    onChange={(value) => changeDurationEndpoint('max', String(value))}
                  />
                </div>
              </div>
              {capability.minDuration === undefined && capability.maxDuration === undefined && (
                <p className="mb-2 text-[10px] text-canvas-text-muted">
                  {t("当前未声明时长范围；拖动或修改端点后才会写入限制。")}
                </p>
              )}
              <div className="relative h-8">
                <div className="pointer-events-none absolute inset-x-1.5 top-1/2 h-1 -translate-y-1/2 rounded-full bg-canvas-border">
                  <div
                    className="absolute inset-y-0 rounded-full bg-brand"
                    style={{
                      left: `${((editorMinDuration - sliderMinDuration) / sliderDurationSpan) * 100}%`,
                      width: `${((editorMaxDuration - editorMinDuration) / sliderDurationSpan) * 100}%`,
                    }}
                  />
                </div>
                <input
                  type="range"
                  min={sliderMinDuration}
                  max={sliderMaxDuration}
                  step="1"
                  value={editorMinDuration}
                  aria-label={t("最短生成时长")}
                  className={`ui-slider pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 [--range-track-background:transparent] focus-visible:z-30 [&::-moz-range-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:pointer-events-auto ${minimumThumbOnTop ? 'z-20' : 'z-10'}`}
                  onPointerDown={() => setDurationDragScale({ min: sliderMinDuration, max: sliderMaxDuration })}
                  onPointerUp={() => setDurationDragScale(undefined)}
                  onPointerCancel={() => setDurationDragScale(undefined)}
                  onBlur={() => setDurationDragScale(undefined)}
                  onChange={(event) => changeDurationEndpoint('min', event.target.value)}
                />
                <input
                  type="range"
                  min={sliderMinDuration}
                  max={sliderMaxDuration}
                  step="1"
                  value={editorMaxDuration}
                  aria-label={t("最长生成时长")}
                  className={`ui-slider pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 [--range-track-background:transparent] focus-visible:z-30 [&::-moz-range-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:pointer-events-auto ${minimumThumbOnTop ? 'z-10' : 'z-20'}`}
                  onPointerDown={() => setDurationDragScale({ min: sliderMinDuration, max: sliderMaxDuration })}
                  onPointerUp={() => setDurationDragScale(undefined)}
                  onPointerCancel={() => setDurationDragScale(undefined)}
                  onBlur={() => setDurationDragScale(undefined)}
                  onChange={(event) => changeDurationEndpoint('max', event.target.value)}
                />
              </div>
              <div className="flex justify-between text-[9px] text-canvas-text-muted" aria-hidden="true">
                {Array.from({ length: 8 }, (_, index) => Math.round(sliderMinDuration + sliderDurationSpan * index / 7))
                  .map((value) => <span key={value}>{value}s</span>)}
              </div>
              <label className="mt-3 flex items-center justify-end gap-2 text-[10px] text-canvas-text-secondary">
                {t("默认时长")}
                <Select fixedMenu
                  className="min-w-0" size="sm"
                  value={capability.defaultDuration ?? ''}
                  onChange={(selectedOptionValue) => commit({
                    ...capability,
                    defaultDuration: selectedOptionValue ? Number(selectedOptionValue) : undefined,
                  })}
                >
                  <option value="">{t("模型默认（未声明）")}</option>
                  {Array.from(
                    { length: editorMaxDuration - editorMinDuration + 1 },
                    (_, index) => editorMinDuration + index,
                  ).map((value) => <option key={value} value={value}>{value}s</option>)}
                </Select>
              </label>
            </div>
          )}
        </section>

        <section className="ui-card space-y-2 p-3">
          <label className="ui-field">
            <span className="ui-label">{t("生成音轨能力")}</span>
            <Select
              fixedMenu
              className="w-full"
              size="sm"
              name="video-audio-capability"
              aria-label={t("生成音轨能力")}
              value={capability.supportsAudio === undefined ? '' : capability.supportsAudio ? 'supported' : 'unsupported'}
              onChange={(value) => commit({
                ...capability,
                supportsAudio: value === '' ? undefined : value === 'supported',
              })}
            >
              <option value="">{t("未声明（接口默认）")}</option>
              <option value="supported">{t("支持（可切换有声/无声）")}</option>
              <option value="unsupported">{t("不支持生成音轨")}</option>
            </Select>
          </label>
          <p className="ui-hint text-[10px] leading-4">
            {t("未确认或接口不提供音频开关时保持未声明；参考音频不受此项影响。 声明支持时，请在调用协议中映射音频开关。")}
          </p>
        </section>

        <section className="rounded-lg border border-canvas-border bg-black/10 p-3">
          <div className="mb-3">
            <span className="text-xs font-medium text-canvas-text">{t("提交前输入校验")}</span>
            <p className="mt-1 text-[10px] leading-4 text-canvas-text-muted">
              {t("留空表示不限制；不符合时会在创建远端任务前拦截，避免无效请求产生费用。")}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-[10px] text-canvas-text-secondary">
              <span>{t('提示词最多字符')}</span>
              <input type="number" min="1" step="1" aria-label={t('提示词最多字符')}
                className="ui-input w-full" value={capability.promptMaxCharacters ?? ''} placeholder={t('不限')}
                onChange={(event) => commit({ ...capability,
                  promptMaxCharacters: optionalNumber(event.target.value, { integer: true }) })} />
            </label>
            <label className="space-y-1 text-[10px] text-canvas-text-secondary">
              <span>{t("提示词最少字符")}</span>
              <input
                type="number"
                min="0"
                step="1"
                className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400/60"
                value={inputConstraints.promptMinCharacters ?? ''}
                placeholder={t("不限")}
                onChange={(event) => commitInputConstraints({
                  ...inputConstraints,
                  promptMinCharacters: optionalNumber(event.target.value, { integer: true }),
                })}
              />
            </label>
            <label className="space-y-1 text-[10px] text-canvas-text-secondary">
              <span>{t("Base64 解码后总上限（MiB）")}</span>
              <input
                type="number"
                min="0"
                step="0.1"
                className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400/60"
                value={inputConstraints.maxBase64DecodedBytes === undefined
                  ? ''
                  : Number((inputConstraints.maxBase64DecodedBytes / (1024 * 1024)).toFixed(2))}
                placeholder={t("不限")}
                onChange={(event) => commitInputConstraints({
                  ...inputConstraints,
                  maxBase64DecodedBytes: optionalNumber(event.target.value, {
                    integer: true,
                    scale: 1024 * 1024,
                  }),
                })}
              />
            </label>
            <label className="space-y-1 text-[10px] text-canvas-text-secondary">
              <span>{t("参考视频最小宽度（px）")}</span>
              <input
                type="number"
                min="0"
                step="1"
                className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400/60"
                value={inputConstraints.referenceVideo?.width?.min ?? ''}
                placeholder={t("不限")}
                onChange={(event) => commitInputConstraints({
                  ...inputConstraints,
                  referenceVideo: {
                    ...inputConstraints.referenceVideo,
                    width: {
                      ...inputConstraints.referenceVideo?.width,
                      min: optionalNumber(event.target.value, { integer: true }),
                    },
                  },
                })}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-[10px] text-canvas-text-secondary">
                <span>{t("视频最短（秒）")}</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400/60"
                  value={inputConstraints.referenceVideo?.durationSeconds?.min ?? ''}
                  placeholder={t("不限")}
                  onChange={(event) => commitReferenceDuration('referenceVideo', 'min', optionalNumber(event.target.value))}
                />
              </label>
              <label className="space-y-1 text-[10px] text-canvas-text-secondary">
                <span>{t("视频最长（秒）")}</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400/60"
                  value={inputConstraints.referenceVideo?.durationSeconds?.max ?? ''}
                  placeholder={t("不限")}
                  onChange={(event) => commitReferenceDuration('referenceVideo', 'max', optionalNumber(event.target.value))}
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-[10px] text-canvas-text-secondary">
                <span>{t("音频最短（秒）")}</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400/60"
                  value={inputConstraints.referenceAudio?.durationSeconds?.min ?? ''}
                  placeholder={t("不限")}
                  onChange={(event) => commitReferenceDuration('referenceAudio', 'min', optionalNumber(event.target.value))}
                />
              </label>
              <label className="space-y-1 text-[10px] text-canvas-text-secondary">
                <span>{t("音频最长（秒）")}</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400/60"
                  value={inputConstraints.referenceAudio?.durationSeconds?.max ?? ''}
                  placeholder={t("不限")}
                  onChange={(event) => commitReferenceDuration('referenceAudio', 'max', optionalNumber(event.target.value))}
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] text-canvas-text-secondary">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-indigo-500"
                  checked={inputConstraints.referenceVideo?.durationSeconds?.maxExclusive ?? false}
                  disabled={inputConstraints.referenceVideo?.durationSeconds?.max === undefined}
                  onChange={(event) => commitReferenceDuration('referenceVideo', 'maxExclusive', event.target.checked)}
                />
                {t("视频最长严格小于")}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-indigo-500"
                  checked={inputConstraints.referenceAudio?.durationSeconds?.maxExclusive ?? false}
                  disabled={inputConstraints.referenceAudio?.durationSeconds?.max === undefined}
                  onChange={(event) => commitReferenceDuration('referenceAudio', 'maxExclusive', event.target.checked)}
                />
                {t("音频最长严格小于")}
              </label>
            </div>
          </div>
        </section>
      </div>

      <div className="mt-4 flex justify-end">
        <button type="button" className="text-[11px] text-canvas-text-secondary hover:text-canvas-text" onClick={() => onChange(undefined)}>{t("清除自定义限制，恢复通用默认")}</button>
      </div>
    </div>
  );
}
