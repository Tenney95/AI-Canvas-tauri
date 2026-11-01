import type { ComfyWorkflowParameter } from '../../../types/comfyWorkflow';
import { comfyWorkflowParameterKey } from '../../../services/comfyWorkflowParameters';
import { getCloudWorkflowParameterPriority } from '../../../services/cloudWorkflowParameterControls';
import CloudWorkflowParameterField from './CloudWorkflowParameterField';
import { useT } from '../../../i18n';

export default function ComfyWorkflowParameterFields({ parameters, values, onChange, disabled }: {
  parameters: readonly ComfyWorkflowParameter[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return <div className="flex min-w-0 flex-col gap-3">
    {[...parameters].sort((a, b) => getCloudWorkflowParameterPriority(a.fieldName, a.label) - getCloudWorkflowParameterPriority(b.fieldName, b.label)).map((field) => {
      const key = comfyWorkflowParameterKey(field);
      const value = values[key] ?? String(field.defaultValue);
      return <div key={key} className="min-w-0">
        <CloudWorkflowParameterField name={field.fieldName} label={field.label} nodeId={field.nodeId}
          type={field.type} value={value} defaultValue={field.defaultValue}
          options={field.options} min={field.min} max={field.max} step={field.step} multiline={field.multiline}
          disabled={disabled} onChange={(next) => onChange({ ...values, [key]: next })}
          onReset={values[key] === undefined ? undefined : () => {
            const next = { ...values }; delete next[key]; onChange(next);
          }} />
        {/^(?:batch_size|batch_count|num_images|num_outputs)$/i.test(field.fieldName) && Number(value) > 1
          && <p className="ui-hint mt-1" role="status">{t('此参数控制工作流内部批量。当前画布只接收首份产物，其余请在 ComfyUI 中查看。')}</p>}
      </div>;
    })}
  </div>;
}
