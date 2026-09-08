/**
 * comfyUIWindowService — ComfyUI 独立窗口工作流保存与导入。
 * 在独立 ComfyUI 窗口（webview）与主窗口之间桥接工作流 JSON，自动推断 IO 节点类型、
 * 校验缺失节点并回传保存结果，经 Tauri invoke 在主进程落盘。
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  WorkflowCategory,
  WorkflowDefinition,
  WorkflowIONode,
  WorkflowIONodeType,
} from '../types';
import { generateId, useAppStore } from '../store/useAppStore';
import { findMissingNodeClasses } from './comfyWorkflowService';

const COMFYUI_SAVE_EVENT = 'comfyui-workflow-save';
const MAX_WORKFLOW_JSON_LENGTH = 16 * 1024 * 1024;

interface ComfyUIWorkflowSavePayload {
  requestId: string;
  workflowId?: string | null;
  name: string;
  category: WorkflowCategory;
  fileName: string;
  fileContent: string;
  editableContent: string;
}

const IO_TYPE_RULES: { patterns: RegExp[]; type: WorkflowIONodeType }[] = [
  { type: 'image', patterns: [/^LoadImage/i] },
  { type: 'video', patterns: [/^LoadVideo/i, /^VHS_LoadVideo/i, /^VHS_LoadVideoPath/i] },
  { type: 'audio', patterns: [/^LoadAudio/i, /^VHS_LoadAudio/i, /^RecordAudio/i] },
  { type: 'prompt', patterns: [/CLIPTextEncode/i, /TextEncode/i, /StringLiteral/i, /PrimitiveString/i, /^ShowText|pysssss/i] },
];

/**
 * 接受手动/助手保存的 `wf-`、内置 `builtin-` 与 MCP 创建的 `workflow-mcp-`。
 * 不认这个 id 就会当成新工作流入库 —— 内置工作流在 ComfyUI 里改完存回来会变成同名副本，
 * 原来那条纹丝不动，默认节点也得重标一遍。
 */
const WORKFLOW_ID_PATTERN = /^(wf|builtin|workflow-mcp)-[A-Za-z0-9._:-]{1,160}$/;
const SAVE_REQUEST_ID_PATTERN = /^save-[A-Za-z0-9._:-]{1,120}$/;

const WORKFLOW_CATEGORIES = new Set<WorkflowCategory>([
  'ai-text',
  'ai-image',
  'ai-video',
  'ai-audio',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isApiWorkflow(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length === 0) return false;
  return Object.values(value).every((node) => (
    isRecord(node)
    && typeof node.class_type === 'string'
    && isRecord(node.inputs)
  ));
}

function isEditableWorkflow(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.nodes);
}

function sanitizeWorkflowFileName(name: string): string {
  const base = name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_') || 'comfyui-workflow';
  return `${base.replace(/\.json$/i, '')}.json`;
}

export function extractComfyUIIONodes(jsonStr: string): WorkflowIONode[] {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(jsonStr) as unknown;
    if (!isRecord(value)) return [];
    parsed = value;
  } catch {
    return [];
  }

  const results: WorkflowIONode[] = [];
  for (const [nodeId, raw] of Object.entries(parsed)) {
    if (!isRecord(raw)) continue;
    const classType = String(raw.class_type || '');
    const title = String((isRecord(raw._meta) ? raw._meta.title : undefined) || classType || '');

    for (const rule of IO_TYPE_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(classType))) {
        results.push({ nodeId, title, type: rule.type });
        break;
      }
    }

    const inputs = isRecord(raw.inputs) ? raw.inputs : undefined;
    // 展示类节点的 text 是给人看的输出，不是提示词入口
    const isDisplayOnly = /showAnything|PreviewAny|DisplayText/i.test(classType);
    if (inputs && !isDisplayOnly && !results.some((item) => item.nodeId === nodeId)) {
      for (const [key, value] of Object.entries(inputs)) {
        if (/text|prompt|writing/i.test(key) && typeof value === 'string' && value.trim()) {
          results.push({ nodeId, title: title || classType || key, type: 'prompt' });
          break;
        }
      }
    }
  }

  return results;
}

/** 只保留仍指向现存 IO 节点的默认设置 */
function pruneDefaultNodes(
  defaultNodes: WorkflowDefinition['defaultNodes'],
  ioNodes: WorkflowIONode[],
): WorkflowDefinition['defaultNodes'] {
  if (!defaultNodes) return undefined;
  const kept: WorkflowDefinition['defaultNodes'] = {};
  for (const [type, nodeId] of Object.entries(defaultNodes) as [WorkflowIONodeType, string][]) {
    if (ioNodes.some((io) => io.nodeId === nodeId && io.type === type)) kept[type] = nodeId;
  }
  return kept;
}

function validateSavePayload(payload: unknown): ComfyUIWorkflowSavePayload {
  if (!isRecord(payload)) throw new Error('ComfyUI 返回的工作流数据无效');
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  const fileContent = typeof payload.fileContent === 'string' ? payload.fileContent : '';
  const editableContent = typeof payload.editableContent === 'string' ? payload.editableContent : '';
  const category = payload.category as WorkflowCategory;
  if (!SAVE_REQUEST_ID_PATTERN.test(requestId)) throw new Error('ComfyUI 保存请求无效');
  if (!name || name.length > 120) throw new Error('工作流名称无效');
  if (!WORKFLOW_CATEGORIES.has(category)) throw new Error('工作流分类无效');
  if (!fileContent || fileContent.length > MAX_WORKFLOW_JSON_LENGTH) throw new Error('API 工作流内容无效或过大');
  if (!editableContent || editableContent.length > MAX_WORKFLOW_JSON_LENGTH) throw new Error('可编辑工作流内容无效或过大');

  let apiWorkflow: unknown;
  let editableWorkflow: unknown;
  try {
    apiWorkflow = JSON.parse(fileContent) as unknown;
    editableWorkflow = JSON.parse(editableContent) as unknown;
  } catch {
    throw new Error('ComfyUI 返回的工作流 JSON 无法解析');
  }
  if (!isApiWorkflow(apiWorkflow) || !isEditableWorkflow(editableWorkflow)) {
    throw new Error('ComfyUI 返回的工作流格式不受支持');
  }

  return {
    requestId,
    workflowId: typeof payload.workflowId === 'string' && WORKFLOW_ID_PATTERN.test(payload.workflowId)
      ? payload.workflowId
      : null,
    name,
    category,
    fileName: sanitizeWorkflowFileName(
      typeof payload.fileName === 'string' && payload.fileName.trim() ? payload.fileName : name,
    ),
    fileContent,
    editableContent,
  };
}

async function completeComfyUIWorkflowSave(
  requestId: string,
  success: boolean,
  detail: string,
): Promise<void> {
  await invoke<void>('complete_comfyui_workflow_save', {
    requestId,
    success,
    detail,
  });
}

export interface ComfyUIWorkflowOpenResult {
  requestId: string;
  nodeCount: number;
  source: 'editable' | 'api' | 'existing';
  detail: string;
  missingNodeClasses: string[];
}

let activeEditorOpen: { key: string; promise: Promise<ComfyUIWorkflowOpenResult> } | null = null;

/** 缺节点检查只作提示，不能因服务器的节点清单请求卡住而永远没有开窗反馈。 */
async function checkEditorNodeClasses(comfyUrl: string, content: string): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      findMissingNodeClasses(comfyUrl, content).catch(() => []),
      new Promise<string[]>((resolve) => { timer = setTimeout(() => resolve([]), 4000); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 只有收到对应请求的非空画布回执才算打开完成；缺节点仍交给 ComfyUI 展示。 */
export function openComfyUIWorkflowEditor(
  comfyUrl: string,
  workflow: WorkflowDefinition,
  onStage?: (stage: 'checking' | 'opening') => void,
): Promise<ComfyUIWorkflowOpenResult> {
  const key = `${comfyUrl.replace(/\/+$/, '')}:${workflow.id}`;
  if (activeEditorOpen) {
    if (activeEditorOpen.key === key) return activeEditorOpen.promise;
    return Promise.reject(new Error('正在打开另一个工作流，请等待当前载入完成'));
  }
  const operation = Promise.resolve().then(async () => {
    if (workflow.fileContent.length > MAX_WORKFLOW_JSON_LENGTH) throw new Error('工作流超过 16 MiB 上限');
    let api: unknown;
    try { api = JSON.parse(workflow.fileContent); } catch { throw new Error('工作流 JSON 无法解析，请重新导入'); }
    if (!isApiWorkflow(api)) throw new Error('工作流没有有效的 API 节点，请重新导入 ComfyUI API 格式工作流');
    onStage?.('checking');
    const missingNodeClasses = await checkEditorNodeClasses(comfyUrl, workflow.fileContent);
    onStage?.('opening');
    const requestId = `open-${generateId()}`;
    const result = await invoke<Omit<ComfyUIWorkflowOpenResult, 'missingNodeClasses'>>('open_comfyui_window', {
      requestId,
      comfyUrl,
      workflowId: workflow.id,
      workflowName: workflow.name,
      workflowCategory: workflow.category,
      workflowFileName: workflow.fileName,
      apiJson: workflow.fileContent,
      editableJson: workflow.editableContent ?? null,
    });
    if (!result || result.requestId !== requestId || !Number.isInteger(result.nodeCount) || result.nodeCount <= 0
      || !['api', 'editable', 'existing'].includes(result.source) || typeof result.detail !== 'string') {
      throw new Error('未收到有效的工作流载入回执，请重试；开发环境修改后需重启桌面应用');
    }
    return { ...result, missingNodeClasses };
  });
  const promise = operation.finally(() => {
    if (activeEditorOpen?.promise === promise) activeEditorOpen = null;
  });
  activeEditorOpen = { key, promise };
  return promise;
}

export async function initComfyUIWindowBridge(): Promise<() => void> {
  if (typeof window === 'undefined' || !('__TAURI__' in window)) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen<unknown>(COMFYUI_SAVE_EVENT, async ({ payload }) => {
    const store = useAppStore.getState();
    const requestId = isRecord(payload) && typeof payload.requestId === 'string'
      ? payload.requestId
      : '';
    try {
      const saved = validateSavePayload(payload);
      const existing = saved.workflowId
        ? store.workflows.find((workflow) => workflow.id === saved.workflowId)
        : undefined;
      const now = Date.now();
      let successMessage: string;
      if (existing) {
        const ioNodes = extractComfyUIIONodes(saved.fileContent);
        await store.updateWorkflow(existing.id, {
          name: saved.name,
          category: saved.category,
          fileName: saved.fileName,
          fileContent: saved.fileContent,
          editableContent: saved.editableContent,
          ioNodes,
          // 在 ComfyUI 里改结构后节点可能已不存在，指向空节点的默认设置要丢掉
          defaultNodes: pruneDefaultNodes(existing.defaultNodes, ioNodes),
          updatedAt: now,
        });
        successMessage = `“${saved.name}”已从 ComfyUI 更新`;
      } else {
        const workflow: WorkflowDefinition = {
          id: saved.workflowId || `wf-${generateId()}`,
          name: saved.name,
          category: saved.category,
          fileName: saved.fileName,
          fileContent: saved.fileContent,
          editableContent: saved.editableContent,
          ioNodes: extractComfyUIIONodes(saved.fileContent),
          createdAt: now,
          updatedAt: now,
        };
        await store.addWorkflow(workflow);
        successMessage = `“${saved.name}”已保存到工作流库`;
      }

      try {
        await completeComfyUIWorkflowSave(saved.requestId, true, saved.name);
      } catch {
        store.showToast(`${successMessage}，但无法通知 ComfyUI 窗口`, 'error');
        return;
      }
      store.showToast(successMessage, 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存 ComfyUI 工作流失败';
      if (SAVE_REQUEST_ID_PATTERN.test(requestId)) {
        try {
          await completeComfyUIWorkflowSave(requestId, false, message);
        } catch {
          // ComfyUI 窗口可能已关闭；主窗口仍需展示真实持久化结果。
        }
      }
      store.showToast(message, 'error');
    }
  });
}
