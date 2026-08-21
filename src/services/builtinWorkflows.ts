/**
 * 内置 ComfyUI 工作流 —— 首次启动时写进「工作流管理」，之后就是普通工作流（可改可删）。
 * 已播种的 id 记在 localStorage 里，删掉的不会自动恢复，新加的下次启动自动补上。
 */
import type { WorkflowDefinition, WorkflowIONodeType } from '../types';
import { extractComfyUIIONodes } from './comfyUIWindowService';
const WORKFLOW_FILES = import.meta.glob('../assets/comfyWorkflows/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** ComfyUI 界面格式的同名工作流；有它才能在 ComfyUI 里正常打开编辑 */
const WORKFLOW_UI_FILES = import.meta.glob('../assets/comfyWorkflows/ui/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function readWorkflowFile(fileName: string): string {
  const path = Object.keys(WORKFLOW_FILES).find((key) => key.endsWith(`/${fileName}`));
  if (!path) throw new Error(`内置工作流文件缺失：${fileName}`);
  return WORKFLOW_FILES[path];
}

function readWorkflowUiFile(fileName: string): string | undefined {
  const path = Object.keys(WORKFLOW_UI_FILES).find((key) => key.endsWith(`/ui/${fileName}`));
  return path ? WORKFLOW_UI_FILES[path] : undefined;
}

const SEEDED_IDS_KEY = 'aicanvas.builtinWorkflows.seededIds';

interface BuiltInWorkflowSpec {
  id: string;
  name: string;
  fileName: string;
  /** 用户没 @ 具体节点时，提示词与参考媒体默认送进这些节点 */
  defaultNodes: Partial<Record<WorkflowIONodeType, string>>;
}

const BUILT_IN_SPECS: BuiltInWorkflowSpec[] = [
  {
    id: 'builtin-minimax-h3-t2v',
    name: 'MiniMax H3 文生视频',
    fileName: 'minimax-h3-t2v.json',
    defaultNodes: { prompt: '105:104' },
  },
  {
    id: 'builtin-minimax-h3-i2v',
    name: 'MiniMax H3 图生视频',
    fileName: 'minimax-h3-i2v.json',
    defaultNodes: { prompt: '105:104', image: '114' },
  },
  {
    id: 'builtin-minimax-h3-r2v',
    name: 'MiniMax H3 参考生视频',
    fileName: 'minimax-h3-r2v.json',
    defaultNodes: { prompt: '138', image: '137' },
  },
  {
    id: 'builtin-minimax-h3-t2v-turbo',
    name: 'MiniMax H3 文生视频（Turbo 加速）',
    fileName: 'minimax-h3-t2v-turbo.json',
    defaultNodes: { prompt: '130' },
  },
  {
    id: 'builtin-minimax-h3-i2v-turbo',
    name: 'MiniMax H3 图生视频（Turbo 加速）',
    fileName: 'minimax-h3-i2v-turbo.json',
    defaultNodes: { prompt: '132', image: '114' },
  },
  {
    id: 'builtin-minimax-h3-r2v-turbo',
    name: 'MiniMax H3 参考生视频（Turbo 加速）',
    fileName: 'minimax-h3-r2v-turbo.json',
    defaultNodes: { prompt: '138', image: '169', video: '167' },
  },
];

function toWorkflowDefinition(spec: BuiltInWorkflowSpec, createdAt: number): WorkflowDefinition {
  const fileContent = readWorkflowFile(spec.fileName);
  return {
    id: spec.id,
    name: spec.name,
    category: 'ai-video',
    fileName: spec.fileName,
    fileContent,
    editableContent: readWorkflowUiFile(spec.fileName),
    ioNodes: extractComfyUIIONodes(fileContent),
    defaultNodes: spec.defaultNodes,
    createdAt,
    updatedAt: createdAt,
  };
}

/**
 * 给早先播种、还没有可编辑图的内置工作流补上界面格式的图。
 * 只补空缺，不覆盖任何已有内容；没什么可补时返回 null。
 */
export function withBuiltInEditableContent(
  workflow: WorkflowDefinition,
): WorkflowDefinition | null {
  if (workflow.editableContent) return null;
  const spec = BUILT_IN_SPECS.find((item) => item.id === workflow.id);
  const editableContent = spec ? readWorkflowUiFile(spec.fileName) : undefined;
  return editableContent ? { ...workflow, editableContent } : null;
}

/**
 * 重新生成全部内置工作流：删掉的补回来，改过的覆盖成随包发布的那份。
 * 同时把播种记账刷成「全部已播种」，避免下次启动再补一遍。
 */
export function resetBuiltInWorkflows(): WorkflowDefinition[] {
  const createdAt = Date.now();
  const workflows = BUILT_IN_SPECS.map((spec) => toWorkflowDefinition(spec, createdAt));
  localStorage.setItem(SEEDED_IDS_KEY, JSON.stringify(workflows.map((workflow) => workflow.id)));
  return workflows;
}

function readSeededIds(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEDED_IDS_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 返回本次启动需要补进工作流列表的内置工作流。
 * 逐个记账而不是打一个总开关：中途出错下次还能补上，用户删掉的也不会自己长回来。
 */
export function pendingBuiltInWorkflows(existing: WorkflowDefinition[]): WorkflowDefinition[] {
  const seededIds = readSeededIds();
  const skip = new Set([...seededIds, ...existing.map((workflow) => workflow.id)]);
  const createdAt = Date.now();
  // 先建好再记账：readWorkflowFile 抛错时这一批下次重来
  const pending = BUILT_IN_SPECS
    .filter((spec) => !skip.has(spec.id))
    .map((spec) => toWorkflowDefinition(spec, createdAt));
  if (pending.length > 0) {
    localStorage.setItem(
      SEEDED_IDS_KEY,
      JSON.stringify([...seededIds, ...pending.map((workflow) => workflow.id)]),
    );
  }
  return pending;
}
