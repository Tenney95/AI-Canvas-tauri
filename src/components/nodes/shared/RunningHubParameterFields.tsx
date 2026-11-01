/**
 * RunningHubParameterFields — 提供RunningHub 模型与工作流参数界面与交互。
 */
import { t, useT } from '../../../i18n';
import type { RunningHubParameter } from '../../../types/runninghub';
import { resolveRunningHubParameters, runningHubParameterKey } from '../../../services/runninghubWorkflowService';
import { getCloudWorkflowParameterPriority, isCloudWorkflowScheduler } from '../../../services/cloudWorkflowParameterControls';
import { runningHubFrameRole, type RunningHubModelDefinition } from '../../../services/ai/providers/runninghubModelManifest';
import Select from '../../shared/Select';
import CloudWorkflowParameterField from './CloudWorkflowParameterField';

// 仅用于缺少枚举的旧 RH 参数展示，取自用户确认的调度器列表；不写回定义或执行校验。
const LEGACY_RH_SCHEDULERS = ['simple', 'sgm_uniform', 'karras', 'exponential', 'ddim_uniform', 'beta', 'normal'];

function frameBindingLabel(field: RunningHubModelDefinition['parameters'][number]): string | undefined {
  const role = runningHubFrameRole(field);
  if (role === 'last_frame') return t('已设置的尾帧');
  if (role === 'first_frame') return t('已设置的首帧');
  return undefined;
}

export function RunningHubModelParameterFields({ model, values = {}, onChange, disabled = false }: {
  model: RunningHubModelDefinition; values?: Record<string, string>;
  onChange: (values: Record<string, string>) => void; disabled?: boolean;
}) {
  const t = useT();
  return <div className="flex min-w-0 flex-col gap-3 text-xs text-canvas-text-secondary">
    <p className="break-all">{model.id} · <a className="underline" href={model.source} target="_blank" rel="noreferrer">{t('官方参数说明')}</a></p>
    {model.parameters.map((field) => {
      const schema = field.schema;
      const value = values[field.name] ?? '';
      const omitted = values[field.name] === '';
      const frameBinding = frameBindingLabel(field);
      const defaultLabel = omitted ? t('本次不传') : field.defaultValue === undefined
        ? frameBinding ? t('使用{reference}', { reference: frameBinding }) : t('自动填入引用或使用平台默认')
        : t('默认：{value}', { value: String(field.defaultValue) });
      const options = schema.enum?.map(String) ?? (schema.type === 'boolean' ? ['true', 'false'] : undefined);
      const fixed = ['stream', 'enable_base64_output'].includes(field.name);
      const update = (next: string) => {
        const copy = { ...values };
        if (next === '') delete copy[field.name]; else copy[field.name] = next;
        onChange(copy);
      };
      return <label key={field.name} className="flex min-w-0 flex-col gap-1">
        <span className="break-words text-canvas-text">{field.label}{field.required ? ' *' : ''} {field.label !== field.name && <span className="text-canvas-text-muted">{field.name}</span>}</span>
        {field.binding === 'prompt' ? <span>{t('使用上方提示词')}</span>
          : fixed ? <span>{t('使用异步 URL 产物（false）')}</span>
            : options ? <Select className="w-full" fixedMenu aria-label={field.label} value={value} disabled={disabled} onChange={update}
              options={[{ value: '', label: defaultLabel }, ...options.map((option) => ({ value: option, label: option }))]} />
              : schema.type === 'number' || schema.type === 'integer' ? <input className="ui-input w-full" type="number" min={schema.minimum} max={schema.maximum} step={schema.multipleOf ?? (schema.type === 'integer' ? 1 : 'any')} placeholder={defaultLabel} value={value} disabled={disabled} onChange={(event) => update(event.target.value)} />
                : <textarea className="ui-textarea w-full" rows={2} placeholder={schema.type === 'array' ? t('{default}；手动填写 JSON 字符串数组', { default: defaultLabel }) : defaultLabel} value={value} disabled={disabled} onChange={(event) => update(event.target.value)} />}
        {field.binding && field.binding !== 'prompt' && <span>{frameBinding
          ? t('仅使用用户{reference}；普通参考图不会自动代填。', { reference: frameBinding })
          : t('自动使用{range}{kind}引用；填写后覆盖自动引用。', { range: schema.type === 'array' ? t('全部') : t('第 {index} 个', { index: (field.referenceIndex ?? 0) + 1 }), kind: t(({ image: '图片', video: '视频', audio: '音频' })[field.binding]) })}</span>}
        {!field.required && field.defaultValue !== undefined && !fixed && <button type="button" className="ui-btn ui-btn--sm self-start" disabled={disabled} onClick={() => {
          if (omitted) update(''); else onChange({ ...values, [field.name]: '' });
        }}>{t(omitted ? '本次不传 · 点击恢复默认' : '本次不传此参数')}</button>}
        <span className="break-words text-canvas-text-muted">{[
          schema.minimum !== undefined || schema.maximum !== undefined ? t('范围 {min}–{max}', { min: schema.minimum ?? t('不限'), max: schema.maximum ?? t('不限') }) : '',
          schema.maxLength !== undefined ? t('最多 {count} 字符', { count: schema.maxLength }) : '',
          schema.maxItems !== undefined ? t('最多 {count} 项', { count: schema.maxItems }) : '',
        ].filter(Boolean).join(' · ')}</span>
        {field.hint && <details><summary className="cursor-pointer">{t('参数说明')}</summary><p className="mt-1 whitespace-pre-wrap break-words">{field.hint}</p></details>}
      </label>;
    })}
  </div>;
}

export default function RunningHubParameterFields({ parameters, values = {}, onChange, disabled = false, appearance = 'form' }: {
  parameters: RunningHubParameter[];
  values?: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  disabled?: boolean;
  appearance?: 'form' | 'popover';
}) {
  const t = useT();
  if (appearance === 'popover') return <div className="flex min-w-0 flex-col gap-3">
    {resolveRunningHubParameters(parameters).filter((field) => field.source === 'value')
      .sort((a, b) => getCloudWorkflowParameterPriority(a.fieldName, a.label) - getCloudWorkflowParameterPriority(b.fieldName, b.label)).map((field) => {
      const key = runningHubParameterKey(field);
      const options = field.options?.length ? field.options
        : field.type === 'string' && isCloudWorkflowScheduler(field.fieldName, field.label)
          && LEGACY_RH_SCHEDULERS.includes(String(field.defaultValue)) ? LEGACY_RH_SCHEDULERS : field.options;
      return <CloudWorkflowParameterField key={key} name={field.fieldName} label={field.label} nodeId={field.nodeId} type={field.type}
        value={values[key] ?? String(field.defaultValue)} defaultValue={field.defaultValue} options={options}
        min={field.min} max={field.max} step={field.step} multiline={field.multiline}
        required={field.required} disabled={disabled} onChange={(next) => onChange({ ...values, [key]: next })}
        onReset={values[key] === undefined ? undefined : () => {
          const next = { ...values }; delete next[key]; onChange(next);
        }} />;
    })}
  </div>;
  return <div className="flex min-w-0 flex-col gap-2">
    {parameters.map((field) => {
      const key = runningHubParameterKey(field);
      const value = values[key] ?? String(field.defaultValue);
      const options = field.options?.map(String) ?? (field.type === 'boolean' ? ['true', 'false'] : undefined);
      return <label key={key} className="flex min-w-0 flex-col gap-1 text-xs text-canvas-text-secondary">
        <span className="break-words">{field.label}{field.required ? ' *' : ''}</span>
        {field.source === 'prompt' ? <span>{t('使用本次提示词')}</span>
          : field.source !== 'value' ? <span>{t('使用第 {index} 个{kind}参考素材', { index: (field.referenceIndex ?? 0) + 1, kind: t(({ image: '图片', video: '视频', audio: '音频' })[field.source]) })}</span>
            : options?.length ? <Select className="w-full" fixedMenu aria-label={field.label} value={value} disabled={disabled}
              onChange={(next) => onChange({ ...values, [key]: next })}
              options={options.map((option) => ({ value: option, label: option }))} />
              : field.type === 'number' ? <input className="ui-input w-full" type="number" step="any" value={value} disabled={disabled} onChange={(event) => onChange({ ...values, [key]: event.target.value })} />
                : <textarea className="ui-textarea w-full" rows={2} value={value} disabled={disabled} onChange={(event) => onChange({ ...values, [key]: event.target.value })} />}
      </label>;
    })}
  </div>;
}
