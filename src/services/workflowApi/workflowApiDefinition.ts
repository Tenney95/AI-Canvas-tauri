import type { ProtocolJsonValue } from '../../types/aiTypes';
import type { DeclarativeWorkflowApiManifest, WorkflowApiDraft, WorkflowApiInputValues, WorkflowApiManifest, WorkflowApiParameter } from '../../types/workflowApi';
import { parseModelExecutionProtocol } from '../ai/modelProtocol';
import { AUTODL_H3_WORKFLOW, resolveWorkflowApiInputValues } from './autodlWorkflowManifest';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }

export function validateWorkflowParameter(value: unknown, spec: WorkflowApiParameter, name: string): void {
  if (value === undefined || (value === '' && spec.type !== 'string')) {
    if (spec.required) throw new Error(`工作流参数 ${name} 必须填写`);
    return;
  }
  const numeric = spec.type === 'number' || spec.type === 'integer';
  if (typeof value !== (numeric ? 'number' : spec.type)
    || (numeric && (!Number.isFinite(value) || (spec.type === 'integer' && !Number.isSafeInteger(value))))) throw new Error(`工作流参数 ${name} 类型不正确`);
  if (typeof value === 'number' && ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max))) throw new Error(`工作流参数 ${name} 超出允许范围`);
  if (spec.options && !spec.options.includes(value as string | number)) throw new Error(`工作流参数 ${name} 不在允许选项中`);
  if (typeof value === 'string' && (value.length > 10000 || (spec.required && !value.trim()))) throw new Error(`工作流参数 ${name} 内容无效`);
}

export function validateDeclarativeWorkflowManifest(value: unknown): asserts value is DeclarativeWorkflowApiManifest {
  if (!record(value) || !keys(value, ['version', 'adapter', 'workflowId', 'connectionId', 'outputKind', 'references', 'parameters', 'prompt', 'protocol', 'businessStatus', 'defaults'])
    || value.version !== 2 || value.adapter !== 'declarative' || typeof value.workflowId !== 'string' || !/^[\w.:-]{1,128}$/.test(value.workflowId)
    || typeof value.connectionId !== 'string' || !/^[\w:-]{1,120}$/.test(value.connectionId)
    || !['image', 'video', 'audio'].includes(String(value.outputKind)) || !record(value.references) || !record(value.parameters)
    || Object.keys(value.parameters).length > 64 || JSON.stringify(value).length > 256000) throw new Error('工作流 API 定义无效');
  for (const [kind, input] of Object.entries(value.references)) {
    if (!['image', 'video', 'audio'].includes(kind) || !record(input) || !keys(input, ['min', 'max', 'extensions'])
      || !Number.isInteger(input.min) || !Number.isInteger(input.max) || Number(input.min) < 0 || Number(input.max) < Number(input.min) || Number(input.max) > 64
      || (input.extensions !== undefined && (!Array.isArray(input.extensions) || input.extensions.length > 32 || input.extensions.some((ext) => typeof ext !== 'string' || !/^[a-z0-9]{1,10}$/.test(ext))))) throw new Error('工作流参考素材能力定义无效');
  }
  for (const [name, spec] of Object.entries(value.parameters)) {
    if (!/^[A-Za-z_]\w{0,63}$/.test(name) || forbidden.has(name) || !record(spec) || !keys(spec, ['type', 'label', 'required', 'default', 'min', 'max', 'options'])
      || !['string', 'number', 'integer', 'boolean'].includes(String(spec.type))
      || (spec.label !== undefined && (typeof spec.label !== 'string' || spec.label.length > 120))
      || (spec.required !== undefined && typeof spec.required !== 'boolean')
      || (spec.min !== undefined && (typeof spec.min !== 'number' || !Number.isFinite(spec.min)))
      || (spec.max !== undefined && (typeof spec.max !== 'number' || !Number.isFinite(spec.max)))
      || (typeof spec.min === 'number' && typeof spec.max === 'number' && spec.min > spec.max)
      || (spec.options !== undefined && (!Array.isArray(spec.options) || !spec.options.length || spec.options.length > 128 || spec.options.some((option) => !['string', 'number'].includes(typeof option))))) throw new Error(`工作流参数 ${name} 定义无效`);
    if (spec.default !== undefined) validateWorkflowParameter(spec.default, spec as unknown as WorkflowApiParameter, name);
  }
  if (value.prompt !== undefined && (!record(value.prompt) || !keys(value.prompt, ['required', 'maxLength'])
    || (value.prompt.required !== undefined && typeof value.prompt.required !== 'boolean')
    || (value.prompt.maxLength !== undefined && (!Number.isInteger(value.prompt.maxLength) || Number(value.prompt.maxLength) < 1 || Number(value.prompt.maxLength) > 100000)))) throw new Error('工作流提示词能力定义无效');
  const protocol = parseModelExecutionProtocol(value.protocol);
  const result = protocol.mode === 'sync' ? protocol.response.result : protocol.poll?.response.result;
  if (protocol.response.type !== 'json' || !result?.urlPath || result.textPath || result.base64Path || result.fetchUrl || protocol.streamFormat) throw new Error('工作流 API 需要配置 JSON 响应中的结果 URL 路径');
  if (value.businessStatus !== undefined) {
    const status = value.businessStatus;
    if (!record(status) || !keys(status, ['path', 'successValues', 'errorPath']) || typeof status.path !== 'string' || !/^[\w.[\]*-]{1,200}$/.test(status.path)
      || !Array.isArray(status.successValues) || !status.successValues.length || status.successValues.length > 20 || status.successValues.some((item) => !['string', 'number'].includes(typeof item))
      || (status.errorPath !== undefined && (typeof status.errorPath !== 'string' || !/^[\w.[\]*-]{1,200}$/.test(status.errorPath)))) throw new Error('工作流业务状态映射无效');
  }
  if (value.defaults !== undefined && (!record(value.defaults) || Object.keys(value.defaults).length > 0)) throw new Error('自定义工作流请在 parameters 中设置默认值');
}

export function workflowApiOutputKind(manifest: WorkflowApiManifest) { return manifest.version === 1 ? 'video' as const : manifest.outputKind; }

export function resolveDeclaredWorkflowInputs(manifest: DeclarativeWorkflowApiManifest, input: WorkflowApiInputValues = {}): WorkflowApiInputValues {
  if (Object.keys(input).some((name) => !Object.hasOwn(manifest.parameters, name))) throw new Error('工作流包含未声明的输入参数');
  return Object.fromEntries(Object.entries(manifest.parameters).flatMap(([name, spec]) => {
    const value = input[name] === undefined ? spec.default : input[name];
    validateWorkflowParameter(value, spec, name);
    return value === undefined ? [] : [[name, value]];
  }));
}

export function createWorkflowApiDraft(template: 'blank' | 'autodl' = 'blank'): WorkflowApiDraft {
  const id = crypto.randomUUID();
  const manifest: DeclarativeWorkflowApiManifest = {
    version: 2, adapter: 'declarative', workflowId: id, connectionId: 'draft-connection', outputKind: 'video',
    references: { image: { min: 0, max: 1 }, audio: { min: 0, max: 0 }, video: { min: 0, max: 0 } },
    parameters: {}, prompt: { required: true, maxLength: 10000 },
    protocol: { version: 2, mode: 'async', auth: { type: 'bearer' },
      submit: { method: 'POST', path: '/workflows/run', body: { prompt: '{{prompt}}', images: '{{imageUrls}}' } },
      response: { type: 'json', taskIdPath: 'data.task_id', errorPath: 'message' },
      poll: { method: 'GET', path: '/tasks/{{submit.data.task_id}}', intervalMs: 3000, maxDurationMs: 7200000,
        response: { statusPath: 'data.status', successValues: ['completed', 'success'], failureValues: ['failed', 'error', 'cancelled'], errorPath: 'message', result: { urlPath: 'data.results[*].url' } } } },
  };
  if (template === 'autodl') {
    const protocol = parseModelExecutionProtocol(manifest.protocol);
    manifest.protocol = protocol;
    manifest.workflowId = AUTODL_H3_WORKFLOW.id;
    manifest.references = { image: { min: 1, max: 9, extensions: [...AUTODL_H3_WORKFLOW.images.extensions] }, audio: { min: 0, max: 3, extensions: [...AUTODL_H3_WORKFLOW.audio.extensions] }, video: { min: 0, max: 0 } };
    manifest.parameters = { duration: { type: 'integer', label: '视频时长（秒）', min: 1, max: 15, default: 5 },
      resolution: { type: 'string', label: '输出分辨率', options: ['480p竖', '768p竖', '480p横', '768p横', '480p(1:1)', '768p(1:1)'], default: '768p竖' },
      seed: { type: 'integer', label: '随机种子' } };
    const body: Record<string, ProtocolJsonValue> = { prompt: '{{prompt}}', duration: '{{parameters.duration}}', resolution: '{{parameters.resolution}}', seed: '{{parameters.seed}}' };
    for (let index = 0; index < 9; index += 1) body[`ref_image_${index}`] = `{{imageUrls.${index}}}`;
    for (let index = 0; index < 3; index += 1) body[`ref_audio_${index}`] = `{{audioUrls.${index}}}`;
    // Authorization 由专用鉴权通道注入；空前缀表示发送原始 Token。
    manifest.protocol.auth = { type: 'bearer', prefix: '' };
    manifest.protocol.submit = { method: 'POST', path: AUTODL_H3_WORKFLOW.submitPath, pathMode: 'origin', body };
    protocol.response.errorPath = 'msg';
    manifest.protocol.poll!.path = `${AUTODL_H3_WORKFLOW.queryPath}{{submit.data.task_id}}`;
    manifest.protocol.poll!.pathMode = 'origin';
    protocol.poll!.response.errorPath = 'msg';
    manifest.businessStatus = { path: 'code', successValues: ['Success'], errorPath: 'msg' };
  }
  return { id, name: template === 'autodl' ? AUTODL_H3_WORKFLOW.name : '自定义工作流', manifest };
}

export function editableWorkflowApiManifest(manifest: WorkflowApiManifest): DeclarativeWorkflowApiManifest {
  if (manifest.version === 2) return structuredClone(manifest);
  const next = createWorkflowApiDraft('autodl').manifest;
  const defaults = resolveWorkflowApiInputValues(manifest.defaults);
  next.connectionId = manifest.connectionId;
  next.workflowId = manifest.workflowId;
  next.parameters.duration.default = defaults.duration;
  next.parameters.resolution.default = `${defaults.resolution}${AUTODL_H3_WORKFLOW.resolutionSuffix[defaults.ratio]}`;
  if (defaults.seed !== undefined) next.parameters.seed.default = defaults.seed;
  return next;
}
