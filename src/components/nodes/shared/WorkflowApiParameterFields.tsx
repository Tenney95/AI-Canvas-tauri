/**
 * WorkflowApiParameterFields — 提供云工作流参数表单界面与交互。
 */
import type { DeclarativeWorkflowApiManifest } from '../../../types/workflowApi';
import { useT } from '../../../i18n';
import { getCloudWorkflowParameterPriority } from '../../../services/cloudWorkflowParameterControls';
import Select from '../../shared/Select';
import CloudWorkflowParameterField from './CloudWorkflowParameterField';
import { isWorkflowSeedParameter, workflowSeedInputValue } from '../../../services/workflowSeed';

export default function WorkflowApiParameterFields({ manifest, values = {}, onChange, disabled, appearance = 'form' }: {
  manifest: DeclarativeWorkflowApiManifest; values?: Record<string, string>; onChange: (values: Record<string, string>) => void; disabled?: boolean;
  appearance?: 'form' | 'popover';
}) {
  const t = useT();
  const currentValue = (name: string) => values[`workflow::${name}`] ?? values[name] ?? '';
  const change = (name: string, value: string, reset = false) => {
    const next = { ...values }; delete next[name]; delete next[`workflow::${name}`];
    const spec = manifest.parameters[name];
    if (!reset && (value !== '' || (appearance === 'popover' && isWorkflowSeedParameter({ ...spec, name, label: spec.label || name })))) next[`workflow::${name}`] = value;
    onChange(next);
  };
  const parameters = Object.entries(manifest.parameters);
  if (appearance === 'popover') parameters.sort(([nameA, specA], [nameB, specB]) =>
    getCloudWorkflowParameterPriority(nameA, specA.label || nameA) - getCloudWorkflowParameterPriority(nameB, specB.label || nameB));
  return <div className={`flex min-w-0 flex-col ${appearance === 'popover' ? 'gap-3' : 'gap-2'}`}>
    <p className="text-xs text-canvas-text-secondary">{(['image', 'video', 'audio'] as const).map((kind) => {
      const limit = manifest.references[kind] ?? { min: 0, max: 0 };
      return `${t(kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频')} ${limit.min}–${limit.max}`;
    }).join(' · ')}</p>
    {parameters.map(([name, spec]) => {
      const defaultValue = spec.default;
      if (appearance === 'popover') return <CloudWorkflowParameterField key={name} name={name} label={spec.label || name}
        type={spec.type} value={workflowSeedInputValue({ ...spec, name, label: spec.label || name }, values[`workflow::${name}`] ?? values[name], defaultValue)}
        displayDefaultWhenEmpty={!isWorkflowSeedParameter({ ...spec, name, label: spec.label || name })} allowRandomSeed
        defaultValue={defaultValue} options={spec.options} min={spec.min} max={spec.max} step={spec.type === 'integer' ? 1 : undefined}
        required={spec.required} disabled={disabled} onChange={(value) => change(name, value)}
        onReset={values[`workflow::${name}`] === undefined && values[name] === undefined ? undefined : () => change(name, '', true)} />;
      return <label key={name} className="flex flex-wrap items-center gap-2 text-xs">
        <span>{spec.label || name}{spec.required ? ' *' : ''}</span>
        {spec.type === 'boolean' || spec.options ? <Select className="min-w-0 flex-1" fixedMenu aria-label={spec.label || name}
          disabled={disabled} value={currentValue(name)} onChange={(value) => change(name, value)}
          options={[
            { value: '', label: defaultValue === undefined ? t('未填写') : `${t('默认值')}：${defaultValue}` },
            ...(spec.type === 'boolean' ? ['true', 'false'] : spec.options ?? []).map((value) => ({ value: String(value), label: String(value) })),
          ]} /> : <input className="ui-input min-w-0 flex-1" disabled={disabled} type={spec.type === 'string' ? 'text' : 'number'}
          step={spec.type === 'integer' ? 1 : 'any'} min={spec.min} max={spec.max} value={currentValue(name)}
          placeholder={defaultValue === undefined ? t('未填写') : String(defaultValue)} onChange={(event) => change(name, event.target.value)} />}
      </label>;
    })}
  </div>;
}
