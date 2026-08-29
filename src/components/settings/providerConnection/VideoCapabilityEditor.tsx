/**
 * settings/providerConnection/VideoCapabilityEditor — 视频模型的固定能力编辑器。
 *
 * 这里勾选的值会直接约束画布上视频节点的可选项，所以编辑器只做「声明」：
 * 未填写的字段一律保持 undefined，绝不替用户猜测默认值。
 */
import { Icon } from '@iconify/react';
import { useState } from 'react';
import type { ProviderModelSelection } from '../../../types';
import type { VideoInputConstraints, VideoModelCapability } from '../../../types/aiTypes';
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
  onClose: () => void;
}

function optionalNumber(value: string, options: { integer?: boolean; scale?: number } = {}): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  const scaled = parsed * (options.scale ?? 1);
  return options.integer ? Math.round(scaled) : scaled;
}

export default function VideoCapabilityEditor({ model, onChange, onClose }: VideoCapabilityEditorProps) {
  const [customRatio, setCustomRatio] = useState('');
  const [customResolution, setCustomResolution] = useState('');
  const [customFrameRate, setCustomFrameRate] = useState('');
  const [customDuration, setCustomDuration] = useState('');
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
  const editorMinDuration = Math.min(
    VIDEO_DURATION_RANGE_MAX,
    Math.max(
      VIDEO_DURATION_RANGE_MIN,
      capability.minDuration ?? Math.min(...(capability.durations ?? [VIDEO_DURATION_RANGE_MIN])),
    ),
  );
  const editorMaxDuration = Math.max(
    editorMinDuration,
    Math.min(
      VIDEO_DURATION_RANGE_MAX,
      capability.maxDuration ?? Math.max(...(capability.durations ?? [15])),
    ),
  );

  const commit = (next: VideoModelCapability) => onChange(createEditableVideoCapability(next));
  const commitInputConstraints = (next: VideoInputConstraints) => commit({
    ...capability,
    inputConstraints: next,
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
  const optionClass = (active: boolean) => `min-h-7 rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
    active
      ? 'border-indigo-400/70 bg-indigo-500/20 text-indigo-100'
      : 'border-canvas-border bg-black/10 text-canvas-text-secondary hover:border-indigo-400/40 hover:text-canvas-text'
  }`;

  return (
    <div className="mt-3 rounded-xl border border-canvas-border bg-canvas-surface/80 p-4 shadow-xl shadow-black/10">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-canvas-text">
            <Icon icon="lucide:video" width="17" className="text-indigo-300" />
            视频参数能力
          </div>
          <p className="mt-1 text-[11px] leading-5 text-canvas-text-secondary">
            {model.name} · 勾选模型实际支持的值，视频节点只会展示这些选项。
          </p>
        </div>
        <PopupCloseButton aria-label="关闭视频参数能力" onClick={onClose} />
      </div>

      <div className="space-y-4">
        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-canvas-text">画面比例（可多选）</span>
            <label className="flex items-center gap-2 text-[10px] text-canvas-text-secondary">
              默认
              <select
                className="h-7 rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text"
                value={capability.defaultRatio ?? ''}
                onChange={(event) => commit({
                  ...capability,
                  defaultRatio: event.target.value || undefined,
                })}
              >
                <option value="">模型默认（未声明）</option>
                {capability.ratios?.map((value) => <option key={value}>{value}</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ratioOptions.map((value) => (
              <button key={value} type="button" aria-pressed={capability.ratios?.includes(value)} className={optionClass(capability.ratios?.includes(value) ?? false)} onClick={() => toggleStringOption('ratios', 'defaultRatio', value)}>
                {value === 'adaptive' ? '自适应' : value}
              </button>
            ))}
            <span className="flex min-h-7 overflow-hidden rounded-md border border-dashed border-canvas-border focus-within:border-indigo-400/60">
              <input className="w-20 bg-transparent px-2 text-[11px] text-canvas-text outline-none" value={customRatio} placeholder="自定义" onChange={(event) => setCustomRatio(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addStringOption('ratios', 'defaultRatio', customRatio, () => setCustomRatio('')); }} />
              <button type="button" className="border-l border-canvas-border px-2 text-indigo-300" aria-label="添加自定义比例" onClick={() => addStringOption('ratios', 'defaultRatio', customRatio, () => setCustomRatio(''))}>+</button>
            </span>
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-canvas-text">分辨率（可多选）</span>
            <label className="flex items-center gap-2 text-[10px] text-canvas-text-secondary">
              默认
              <select className="h-7 rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text" value={capability.defaultResolution ?? ''} onChange={(event) => commit({ ...capability, defaultResolution: event.target.value || undefined })}>
                <option value="">模型默认（未声明）</option>
                {capability.resolutions?.map((value) => <option key={value}>{value}</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {resolutionOptions.map((value) => (
              <button key={value} type="button" aria-pressed={capability.resolutions?.includes(value)} className={optionClass(capability.resolutions?.includes(value) ?? false)} onClick={() => toggleStringOption('resolutions', 'defaultResolution', value)}>{value}</button>
            ))}
            <span className="flex min-h-7 overflow-hidden rounded-md border border-dashed border-canvas-border focus-within:border-indigo-400/60">
              <input className="w-20 bg-transparent px-2 text-[11px] text-canvas-text outline-none" value={customResolution} placeholder="自定义" onChange={(event) => setCustomResolution(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addStringOption('resolutions', 'defaultResolution', customResolution, () => setCustomResolution('')); }} />
              <button type="button" className="border-l border-canvas-border px-2 text-indigo-300" aria-label="添加自定义分辨率" onClick={() => addStringOption('resolutions', 'defaultResolution', customResolution, () => setCustomResolution(''))}>+</button>
            </span>
          </div>
          <p className="mt-1.5 text-[10px] text-canvas-text-muted">同时提供 480p/1080p 等接口档位和 480/832 等长边像素；请按厂商文档勾选。</p>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-canvas-text">帧率（可多选）</span>
            <label className="flex items-center gap-2 text-[10px] text-canvas-text-secondary">
              默认
              <select className="h-7 rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text" value={capability.defaultFrameRate ?? ''} onChange={(event) => commit({ ...capability, defaultFrameRate: event.target.value ? Number(event.target.value) : undefined })}>
                <option value="">模型默认（未声明）</option>
                {capability.frameRates?.map((value) => <option key={value} value={value}>{value} FPS</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {frameRateOptions.map((value) => (
              <button key={value} type="button" aria-pressed={capability.frameRates?.includes(value)} className={optionClass(capability.frameRates?.includes(value) ?? false)} onClick={() => toggleFrameRate(value)}>{value} FPS</button>
            ))}
            <span className="flex min-h-7 overflow-hidden rounded-md border border-dashed border-canvas-border focus-within:border-indigo-400/60">
              <input type="number" min="1" max="240" className="w-20 bg-transparent px-2 text-[11px] text-canvas-text outline-none" value={customFrameRate} placeholder="自定义" onChange={(event) => setCustomFrameRate(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { const value = Number(customFrameRate); if (Number.isInteger(value) && value > 0 && value <= 240) { if (!capability.frameRates?.includes(value)) toggleFrameRate(value); setCustomFrameRate(''); } } }} />
              <button type="button" className="border-l border-canvas-border px-2 text-indigo-300" aria-label="添加自定义帧率" onClick={() => { const value = Number(customFrameRate); if (Number.isInteger(value) && value > 0 && value <= 240) { if (!capability.frameRates?.includes(value)) toggleFrameRate(value); setCustomFrameRate(''); } }}>+</button>
            </span>
          </div>
        </section>

        <section className="rounded-lg border border-canvas-border bg-black/10 p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs font-medium text-canvas-text">生成时长</span>
            <div className="flex rounded-md border border-canvas-border bg-canvas-card p-0.5" role="group" aria-label="时长模式">
              <button type="button" className={`rounded px-2.5 py-1 text-[10px] ${!discreteDurations ? 'bg-indigo-500/25 text-indigo-100' : 'text-canvas-text-secondary'}`} onClick={() => commit({ ...capability, durations: undefined, minDuration: capability.minDuration ?? VIDEO_DURATION_RANGE_MIN, maxDuration: capability.maxDuration ?? 15 })}>连续范围</button>
              <button type="button" className={`rounded px-2.5 py-1 text-[10px] ${discreteDurations ? 'bg-indigo-500/25 text-indigo-100' : 'text-canvas-text-secondary'}`} onClick={() => commit({ ...capability, durations: [capability.defaultDuration ?? 5] })}>固定档位</button>
            </div>
          </div>
          {discreteDurations ? (
            <div className="flex flex-wrap gap-1.5">
              {durationOptions.map((value) => (
                <button key={value} type="button" aria-pressed={discreteDurations.includes(value)} className={optionClass(discreteDurations.includes(value))} onClick={() => toggleDuration(value)}>{value}s</button>
              ))}
              <span className="flex min-h-7 overflow-hidden rounded-md border border-dashed border-canvas-border focus-within:border-indigo-400/60">
                <input type="number" min={VIDEO_DURATION_RANGE_MIN} max={VIDEO_DURATION_RANGE_MAX} className="w-20 bg-transparent px-2 text-[11px] text-canvas-text outline-none" value={customDuration} placeholder="自定义秒" onChange={(event) => setCustomDuration(event.target.value)} />
                <button type="button" className="border-l border-canvas-border px-2 text-indigo-300" aria-label="添加自定义时长" onClick={() => { const value = Number(customDuration); if (Number.isInteger(value) && value >= VIDEO_DURATION_RANGE_MIN && value <= VIDEO_DURATION_RANGE_MAX) { if (!discreteDurations.includes(value)) toggleDuration(value); setCustomDuration(''); } }}>+</button>
              </span>
              <label className="ml-auto flex items-center gap-2 text-[10px] text-canvas-text-secondary">
                默认
                <select className="h-7 rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text" value={capability.defaultDuration ?? ''} onChange={(event) => commit({ ...capability, defaultDuration: event.target.value ? Number(event.target.value) : undefined })}>
                  <option value="">模型默认（未声明）</option>
                  {discreteDurations.map((value) => <option key={value} value={value}>{value}s</option>)}
                </select>
              </label>
            </div>
          ) : (
            <div>
              <div className="mb-2 flex items-center justify-between text-[11px] font-medium text-canvas-text">
                <span>最短 {capability.minDuration ?? '未声明'}</span>
                <span>最长 {capability.maxDuration ?? '未声明'}</span>
              </div>
              {capability.minDuration === undefined && capability.maxDuration === undefined && (
                <p className="mb-2 text-[10px] text-canvas-text-muted">
                  当前未声明时长范围；滑动端点后才会写入限制。
                </p>
              )}
              <div className="relative h-8">
                <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-canvas-card" />
                <div
                  className="pointer-events-none absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.35)]"
                  style={{
                    left: `${((editorMinDuration - VIDEO_DURATION_RANGE_MIN) / (VIDEO_DURATION_RANGE_MAX - VIDEO_DURATION_RANGE_MIN)) * 100}%`,
                    width: `${((editorMaxDuration - editorMinDuration) / (VIDEO_DURATION_RANGE_MAX - VIDEO_DURATION_RANGE_MIN)) * 100}%`,
                  }}
                />
                <input
                  type="range"
                  min={VIDEO_DURATION_RANGE_MIN}
                  max={VIDEO_DURATION_RANGE_MAX}
                  step="1"
                  value={editorMinDuration}
                  aria-label="最短生成时长"
                  className="rh-duration-input pointer-events-none absolute inset-0 z-20 [&::-moz-range-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:pointer-events-auto"
                  style={{ position: 'absolute', top: 4, left: 0, right: 0, zIndex: 20 }}
                  onChange={(event) => {
                    const minDuration = Math.min(Number(event.target.value), editorMaxDuration);
                    commit({
                      ...capability,
                      minDuration,
                      ...(capability.defaultDuration === undefined
                        ? {}
                        : { defaultDuration: Math.max(minDuration, capability.defaultDuration) }),
                    });
                  }}
                />
                <input
                  type="range"
                  min={VIDEO_DURATION_RANGE_MIN}
                  max={VIDEO_DURATION_RANGE_MAX}
                  step="1"
                  value={editorMaxDuration}
                  aria-label="最长生成时长"
                  className="rh-duration-input pointer-events-none absolute inset-0 z-10 [&::-moz-range-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:pointer-events-auto"
                  style={{ position: 'absolute', top: 4, left: 0, right: 0, zIndex: 10 }}
                  onChange={(event) => {
                    const maxDuration = Math.max(Number(event.target.value), editorMinDuration);
                    commit({
                      ...capability,
                      maxDuration,
                      ...(capability.defaultDuration === undefined
                        ? {}
                        : { defaultDuration: Math.min(maxDuration, capability.defaultDuration) }),
                    });
                  }}
                />
              </div>
              <div className="flex justify-between text-[9px] text-canvas-text-muted" aria-hidden="true">
                {[2, 6, 10, 14, 18, 22, 26, 30].map((value) => <span key={value}>{value}s</span>)}
              </div>
              <label className="mt-3 flex items-center justify-end gap-2 text-[10px] text-canvas-text-secondary">
                默认时长
                <select
                  className="h-7 rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text"
                  value={capability.defaultDuration ?? ''}
                  onChange={(event) => commit({
                    ...capability,
                    defaultDuration: event.target.value ? Number(event.target.value) : undefined,
                  })}
                >
                  <option value="">模型默认（未声明）</option>
                  {Array.from(
                    { length: editorMaxDuration - editorMinDuration + 1 },
                    (_, index) => editorMinDuration + index,
                  ).map((value) => <option key={value} value={value}>{value}s</option>)}
                </select>
              </label>
            </div>
          )}
        </section>

        <section className="rounded-lg border border-canvas-border bg-black/10 p-3">
          <div className="mb-3">
            <span className="text-xs font-medium text-canvas-text">提交前输入校验</span>
            <p className="mt-1 text-[10px] leading-4 text-canvas-text-muted">
              留空表示不限制；不符合时会在创建远端任务前拦截，避免无效请求产生费用。
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-[10px] text-canvas-text-secondary">
              <span>提示词最少字符</span>
              <input
                type="number"
                min="0"
                step="1"
                className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400/60"
                value={inputConstraints.promptMinCharacters ?? ''}
                placeholder="不限"
                onChange={(event) => commitInputConstraints({
                  ...inputConstraints,
                  promptMinCharacters: optionalNumber(event.target.value, { integer: true }),
                })}
              />
            </label>
            <label className="space-y-1 text-[10px] text-canvas-text-secondary">
              <span>Base64 解码后总上限（MiB）</span>
              <input
                type="number"
                min="0"
                step="0.1"
                className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400/60"
                value={inputConstraints.maxBase64DecodedBytes === undefined
                  ? ''
                  : Number((inputConstraints.maxBase64DecodedBytes / (1024 * 1024)).toFixed(2))}
                placeholder="不限"
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
              <span>参考视频最小宽度（px）</span>
              <input
                type="number"
                min="0"
                step="1"
                className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400/60"
                value={inputConstraints.referenceVideo?.width?.min ?? ''}
                placeholder="不限"
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
                <span>视频最短（秒）</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400/60"
                  value={inputConstraints.referenceVideo?.durationSeconds?.min ?? ''}
                  placeholder="不限"
                  onChange={(event) => commitInputConstraints({
                    ...inputConstraints,
                    referenceVideo: {
                      ...inputConstraints.referenceVideo,
                      durationSeconds: {
                        ...inputConstraints.referenceVideo?.durationSeconds,
                        min: optionalNumber(event.target.value),
                      },
                    },
                  })}
                />
              </label>
              <label className="space-y-1 text-[10px] text-canvas-text-secondary">
                <span>视频最长（秒）</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400/60"
                  value={inputConstraints.referenceVideo?.durationSeconds?.max ?? ''}
                  placeholder="不限"
                  onChange={(event) => commitInputConstraints({
                    ...inputConstraints,
                    referenceVideo: {
                      ...inputConstraints.referenceVideo,
                      durationSeconds: {
                        ...inputConstraints.referenceVideo?.durationSeconds,
                        max: optionalNumber(event.target.value),
                      },
                    },
                  })}
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-[10px] text-canvas-text-secondary">
                <span>音频最短（秒）</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400/60"
                  value={inputConstraints.referenceAudio?.durationSeconds?.min ?? ''}
                  placeholder="不限"
                  onChange={(event) => commitInputConstraints({
                    ...inputConstraints,
                    referenceAudio: {
                      ...inputConstraints.referenceAudio,
                      durationSeconds: {
                        ...inputConstraints.referenceAudio?.durationSeconds,
                        min: optionalNumber(event.target.value),
                      },
                    },
                  })}
                />
              </label>
              <label className="space-y-1 text-[10px] text-canvas-text-secondary">
                <span>音频最长（秒）</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-indigo-400/60"
                  value={inputConstraints.referenceAudio?.durationSeconds?.max ?? ''}
                  placeholder="不限"
                  onChange={(event) => commitInputConstraints({
                    ...inputConstraints,
                    referenceAudio: {
                      ...inputConstraints.referenceAudio,
                      durationSeconds: {
                        ...inputConstraints.referenceAudio?.durationSeconds,
                        max: optionalNumber(event.target.value),
                      },
                    },
                  })}
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
                  onChange={(event) => commitInputConstraints({
                    ...inputConstraints,
                    referenceVideo: {
                      ...inputConstraints.referenceVideo,
                      durationSeconds: {
                        ...inputConstraints.referenceVideo?.durationSeconds,
                        maxExclusive: event.target.checked,
                      },
                    },
                  })}
                />
                视频最长严格小于
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-indigo-500"
                  checked={inputConstraints.referenceAudio?.durationSeconds?.maxExclusive ?? false}
                  disabled={inputConstraints.referenceAudio?.durationSeconds?.max === undefined}
                  onChange={(event) => commitInputConstraints({
                    ...inputConstraints,
                    referenceAudio: {
                      ...inputConstraints.referenceAudio,
                      durationSeconds: {
                        ...inputConstraints.referenceAudio?.durationSeconds,
                        maxExclusive: event.target.checked,
                      },
                    },
                  })}
                />
                音频最长严格小于
              </label>
            </div>
          </div>
        </section>
      </div>

      <div className="mt-4 flex justify-end">
        <button type="button" className="text-[11px] text-canvas-text-secondary hover:text-canvas-text" onClick={() => onChange(undefined)}>清除自定义限制，恢复通用默认</button>
      </div>
    </div>
  );
}
