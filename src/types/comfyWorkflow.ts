/** 目标 ComfyUI /object_info 声明；只用于现有 API 图的标量参数编辑。 */
export interface ComfyInputSpec {
  options?: unknown[];
  type?: string;
  optional?: boolean;
  min?: number;
  max?: number;
  step?: number;
  multiline?: boolean;
}

export interface ComfyWorkflowParameter {
  nodeId: string;
  fieldName: string;
  classType: string;
  label: string;
  type: 'string' | 'number' | 'integer' | 'boolean';
  defaultValue: string | number | boolean;
  options?: readonly (string | number | boolean)[];
  min?: number;
  max?: number;
  step?: number;
  multiline?: boolean;
}

export interface ComfyWorkflowParameterAssignment {
  field: ComfyWorkflowParameter;
  value: string | number | boolean;
}
