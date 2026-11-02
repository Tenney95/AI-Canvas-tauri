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
  /** 已由语音专用面板管理模式，通用参数不再额外默认随机。 */
  dedicatedSeedControl?: true;
}

export interface ComfyWorkflowParameterAssignment {
  field: ComfyWorkflowParameter;
  value: string | number | boolean;
  /** 本次新请求已解析的随机值；可选分支裁剪后不要求不存在的种子节点继续写入。 */
  randomSeed?: true;
}
