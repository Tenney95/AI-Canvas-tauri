/**
 * ai/generateAudio — 音频生成入口
 */
import { useAppStore } from '../../store/useAppStore';
import { DEFAULT_BASE_URLS } from '../../constants/api';
import { resolveNodeReferences } from '../nodeReferenceService';
import { executeComfyUIAudioGenerate } from '../comfyWorkflowService';
import type { AIAudioGenParams } from '../aiTypes';
import { extractModelName, resolveGeneralModel } from './helpers';
import { executeGeneralAsyncTask, generateApimartAudio } from './apimartGen';

export async function generateAudio(params: AIAudioGenParams): Promise<{ url: string }> {
  const { prompt: rawPrompt, model, provider } = params;

  // 解析 @{nodeId:label} 引用为对应节点的实际输出内容
  const prompt = resolveNodeReferences(rawPrompt);

  // ComfyUI 工作流执行路径
  if (params.workflowId) {
    return executeComfyUIAudioGenerate({ ...params, prompt });
  }

  // APIMart 音频生成 — 异步提交 + 轮询
  if (provider === 'apimart') {
    const config = useAppStore.getState().config;
    const providerConfig = config.providers.apimart;
    const apiKey = providerConfig?.apiKey || '';
    if (!apiKey) {
      throw new Error('未配置 apimart 的 API Key\n请在「设置 → API Key」中配置');
    }
    const baseUrl = (providerConfig?.baseUrl || DEFAULT_BASE_URLS.apimart || '').replace(/\/+$/, '');
    if (!baseUrl) {
      throw new Error('未配置 apimart 的服务地址\n请在「设置 → API Key」中添加');
    }
    const modelName = extractModelName(model, provider);
    return generateApimartAudio(apiKey, baseUrl, modelName, prompt, params.nodeId);
  }

  // ── 通用模型音频生成 ──
  if (provider === 'general') {
    const gm = resolveGeneralModel(model);
    if (!gm) throw new Error('未找到该通用模型配置\n请在「设置 → API Key」中检查');
    if (!gm.openaiUrl) throw new Error(`通用模型 "${gm.name}" 未配置接口地址`);
    return executeGeneralAsyncTask(gm.apiKey || '', gm.openaiUrl, gm.modelId, prompt, 'audios', params.nodeId);
  }

  // 无 workflowId 时暂不支持直接调用 API，提示配置
  throw new Error('音频生成需要选择 ComfyUI 工作流\n请在模型选择器中导入并选择工作流');
}
