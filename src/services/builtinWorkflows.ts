/**
 * 内置 ComfyUI 工作流 —— 首次启动时写进「工作流管理」，之后就是普通工作流（可改可删）。
 * 已播种的 id 记在 localStorage 里，删掉的不会自动恢复，新加的下次启动自动补上。
 */
import type { WorkflowDefinition, WorkflowIONodeType } from '../types';
import { extractComfyUIIONodes } from './comfyUIWindowService';
// 退役图保留为手动导入兼容性的回归样本，不再打入内置资源。
const WORKFLOW_FILES = import.meta.glob([
  '../assets/comfyWorkflows/*.json',
  '!../assets/comfyWorkflows/minimax-h3-t2v.json',
  '!../assets/comfyWorkflows/minimax-h3-t2v-turbo.json',
  '!../assets/comfyWorkflows/minimax-h3-r2v.json',
  '!../assets/comfyWorkflows/minimax-h3-r2v-turbo.json',
], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** ComfyUI 界面格式的同名工作流；有它才能在 ComfyUI 里正常打开编辑 */
const WORKFLOW_UI_FILES = import.meta.glob([
  '../assets/comfyWorkflows/ui/*.json',
  '!../assets/comfyWorkflows/ui/minimax-h3-t2v.json',
  '!../assets/comfyWorkflows/ui/minimax-h3-r2v.json',
], {
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
export const RETIRED_BUILT_IN_WORKFLOW_IDS = [
  'builtin-minimax-h3-pdd-r2v-lowvram',
  'builtin-minimax-h3-t2v',
  'builtin-minimax-h3-t2v-turbo',
  'builtin-minimax-h3-r2v',
  'builtin-minimax-h3-r2v-turbo',
] as const;

export function isRetiredBuiltInWorkflow(id: string): boolean {
  return RETIRED_BUILT_IN_WORKFLOW_IDS.some((retiredId) => retiredId === id);
}

interface BuiltInWorkflowSpec {
  id: string;
  name: string;
  fileName: string;
  category?: WorkflowDefinition['category'];
  /** 用户没 @ 具体节点时，提示词与参考媒体默认送进这些节点 */
  defaultNodes: Partial<Record<WorkflowIONodeType, string>>;
}

const BUILT_IN_SPECS: BuiltInWorkflowSpec[] = [
  {
    id: 'builtin-dlss5-image-enhance',
    name: 'DLSS5 图片材质增强',
    fileName: 'dlss5-image-enhance.json',
    category: 'ai-image',
    defaultNodes: { image: '1' },
  },
  {
    id: 'builtin-dlss5-video-enhance',
    name: 'DLSS5 视频材质增强',
    fileName: 'dlss5-video-enhance.json',
    category: 'ai-video',
    defaultNodes: { video: '1' },
  },
  {
    id: 'builtin-qwen3-voice-clone',
    name: 'Qwen3-TTS-01-原声1比1克隆',
    fileName: 'qwen3-voice-clone.json',
    category: 'ai-audio',
    defaultNodes: { prompt: '3', audio: '1' },
  },
  {
    id: 'builtin-qwen3-voice-design',
    name: 'Qwen3-TTS-02-文生语音抽卡',
    fileName: 'qwen3-voice-design.json',
    category: 'ai-audio',
    defaultNodes: { prompt: '1' },
  },
  {
    id: 'builtin-qwen3-reference-voice-design',
    name: 'Qwen3-TTS-03-参考音频抽卡-支持方言',
    fileName: 'qwen3-reference-voice-design.json',
    category: 'ai-audio',
    defaultNodes: { prompt: '3', audio: '1' },
  },
  {
    id: 'builtin-auk-tts',
    name: 'AuK 文生语音',
    fileName: 'auk-tts.json',
    category: 'ai-audio',
    defaultNodes: { prompt: '4' },
  },
  {
    id: 'builtin-auk-voice-cloning',
    name: 'AuK 参考音频与声音克隆',
    fileName: 'auk-voice-cloning.json',
    category: 'ai-audio',
    defaultNodes: { prompt: '10', audio: '7' },
  },
  {
    id: 'builtin-minimax-h3-i2v',
    name: 'MiniMax H3 图生视频',
    fileName: 'minimax-h3-i2v.json',
    defaultNodes: { prompt: '105:104', image: '114' },
  },
  {
    id: 'builtin-minimax-h3-i2v-turbo',
    name: 'MiniMax H3 图生视频（Turbo 加速）',
    fileName: 'minimax-h3-i2v-turbo.json',
    defaultNodes: { prompt: '132', image: '114' },
  },
  {
    id: 'builtin-minimax-h3-i2v-fast-12gb',
    name: 'MiniMax H3 图生视频（12GB 极速·4B）',
    fileName: 'minimax-h3-i2v-fast-12gb.json',
    defaultNodes: { prompt: '132', image: '114' },
  },
  {
    id: 'builtin-minimax-h3-pdd-i2v',
    name: 'MiniMax H3 PDD 图生视频',
    fileName: 'minimax-h3-pdd-i2v.json',
    defaultNodes: { prompt: '7', image: '27' },
  },
  {
    id: 'builtin-minimax-h3-pdd-i2v-audio',
    name: 'MiniMax H3 PDD 图生视频＋参考音频',
    fileName: 'minimax-h3-pdd-i2v-audio.json',
    defaultNodes: { prompt: '19', image: '35', audio: '28' },
  },
  {
    id: 'builtin-minimax-h3-pdd-r2v',
    name: 'MiniMax H3 PDD 自由参考（图片·视频·音频可选）',
    fileName: 'minimax-h3-pdd-r2v.json',
    // 音频沿 IO 列表顺序填充，无需单独指定默认节点。
    defaultNodes: { prompt: '19', image: '101', video: '201' },
  },
  {
    id: 'builtin-breeze-tts2-voice-clone',
    name: 'Breeze TTS 2 声音克隆',
    fileName: 'breeze-tts2-voice-clone.json',
    category: 'ai-audio',
    defaultNodes: { prompt: '12', audio: '8' },
  },
  {
    id: 'builtin-breeze-tts2-voice-design',
    name: 'Breeze TTS 2 声音设计',
    fileName: 'breeze-tts2-voice-design.json',
    category: 'ai-audio',
    defaultNodes: { prompt: '4' },
  },
];

function toWorkflowDefinition(spec: BuiltInWorkflowSpec, createdAt: number): WorkflowDefinition {
  const fileContent = readWorkflowFile(spec.fileName);
  return {
    id: spec.id,
    name: spec.name,
    category: spec.category ?? 'ai-video',
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
 * 升级早先播种的内置工作流：补可编辑图，修正旧模型引用和 H3 PDD 视频解码连线。
 * 只处理可明确识别的旧值，不覆盖用户改成其他有效模型的选择；没变化时返回 null。
 */
export function withBuiltInEditableContent(
  workflow: WorkflowDefinition,
): WorkflowDefinition | null {
  let upgraded = workflow;
  let changed = false;

  if (workflow.id === 'builtin-minimax-h3-i2v-fast-12gb') {
    try {
      const graph = JSON.parse(workflow.fileContent) as Record<string, {
        inputs?: Record<string, unknown>;
      }>;
      const projection = graph['127']?.inputs?.projection;
      if (projection === 'mmh3-4b-ClipProj-v3-mlp.safetensors') {
        graph['127'].inputs!.projection = 'mmh3-4b-ClipProj-v3.1.safetensors';
        changed = true;
      }
      if (graph['127']?.inputs?.mode === 'resident') {
        graph['127'].inputs!.mode = 'streaming';
        changed = true;
      }
      if (graph['123']?.inputs?.steps === 6) {
        graph['123'].inputs!.steps = 4;
        changed = true;
      }
      if (changed) {
        upgraded = { ...upgraded, fileContent: JSON.stringify(graph) };
      }
    } catch {
      // 用户内容不是有效 JSON 时保持原样，由既有工作流校验负责报告。
    }
  }

  // 只迁移仍是旧版直连的 API 图。已有可编辑图由用户维护，避免 UI 图与 API 图分叉。
  if (workflow.id === 'builtin-minimax-h3-pdd-r2v' && !workflow.editableContent) {
    try {
      const graph = JSON.parse(upgraded.fileContent) as Record<string, {
        class_type?: string;
        inputs?: Record<string, unknown>;
      }>;
      const videoDecode = graph['33'];
      const samples = videoDecode?.inputs?.samples;
      if (graph['16']?.class_type === 'SamplerCustomAdvanced'
        && videoDecode?.class_type === 'VAEDecode'
        && Array.isArray(samples) && samples[0] === '16' && samples[1] === 0
        && !graph['900']) {
        const currentGraph = JSON.parse(readWorkflowFile('minimax-h3-pdd-r2v.json')) as typeof graph;
        const unloadNode = currentGraph['900'];
        if (unloadNode?.class_type === 'FL_UnloadAllModels') {
          graph['900'] = unloadNode;
          videoDecode.inputs!.samples = ['900', 0];
          upgraded = { ...upgraded, fileContent: JSON.stringify(graph) };
          changed = true;
        }
      }
    } catch {
      // 不能辨认的用户工作流保持原样，不做自动修复。
    }
  }

  if (upgraded.editableContent) return changed ? upgraded : null;
  const spec = BUILT_IN_SPECS.find((item) => item.id === workflow.id);
  const editableContent = spec ? readWorkflowUiFile(spec.fileName) : undefined;
  if (editableContent) {
    upgraded = { ...upgraded, editableContent };
    changed = true;
  }
  return changed ? upgraded : null;
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
