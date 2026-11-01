import type { ComfyWorkflowParameter } from '../../../types/comfyWorkflow';
import { comfyWorkflowParameterKey } from '../../../services/comfyWorkflowParameters';
import { getCloudWorkflowParameterPriority } from '../../../services/cloudWorkflowParameterControls';
import CloudWorkflowParameterField from './CloudWorkflowParameterField';

export default function ComfyWorkflowParameterFields({ parameters, values, onChange, disabled }: {
  parameters: readonly ComfyWorkflowParameter[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  disabled?: boolean;
}) {
  return <div className="flex min-w-0 flex-col gap-3">
    {[...parameters].sort((a, b) => getCloudWorkflowParameterPriority(a.fieldName, a.label) - getCloudWorkflowParameterPriority(b.fieldName, b.label)).map((field) => {
      const key = comfyWorkflowParameterKey(field);
      return <CloudWorkflowParameterField key={key} name={field.fieldName} label={field.label} nodeId={field.nodeId}
        type={field.type} value={values[key] ?? String(field.defaultValue)} defaultValue={field.defaultValue}
        options={field.options} min={field.min} max={field.max} step={field.step} multiline={field.multiline}
        disabled={disabled} onChange={(next) => onChange({ ...values, [key]: next })}
        onReset={values[key] === undefined ? undefined : () => {
          const next = { ...values }; delete next[key]; onChange(next);
        }} />;
    })}
  </div>;
}
