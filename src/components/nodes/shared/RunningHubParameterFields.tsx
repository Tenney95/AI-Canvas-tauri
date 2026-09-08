import type { RunningHubParameter } from '../../../types/runninghub';
import { runningHubParameterKey } from '../../../services/runninghubWorkflowService';

export default function RunningHubParameterFields({ parameters, values = {}, onChange, disabled = false }: {
  parameters: RunningHubParameter[];
  values?: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  disabled?: boolean;
}) {
  return <div className="flex min-w-0 flex-col gap-2">
    {parameters.map((field) => {
      const key = runningHubParameterKey(field);
      const value = values[key] ?? String(field.defaultValue);
      const options = field.options?.map(String) ?? (field.type === 'boolean' ? ['true', 'false'] : undefined);
      return <label key={key} className="flex min-w-0 flex-col gap-1 text-xs text-canvas-text-secondary">
        <span className="break-words">{field.label}{field.required ? ' *' : ''}</span>
        {field.source === 'prompt' ? <span>使用本次提示词</span>
          : field.source !== 'value' ? <span>使用第 {(field.referenceIndex ?? 0) + 1} 个{({ image: '图片', video: '视频', audio: '音频' })[field.source]}参考素材</span>
            : options?.length ? <select className="ui-select__control w-full" value={value} disabled={disabled} onChange={(event) => onChange({ ...values, [key]: event.target.value })}>
              {options.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
              : field.type === 'number' ? <input className="ui-input w-full" type="number" step="any" value={value} disabled={disabled} onChange={(event) => onChange({ ...values, [key]: event.target.value })} />
                : <textarea className="ui-textarea w-full" rows={2} value={value} disabled={disabled} onChange={(event) => onChange({ ...values, [key]: event.target.value })} />}
      </label>;
    })}
  </div>;
}
