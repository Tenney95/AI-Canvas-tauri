/**
 * assistantService — 对话助手编排服务
 *
 * 职责：
 * 1. 构建脱敏画布上下文（CanvasContext）
 * 2. 编排意图解析管线：本地规则 → (可选) LLM → 规划 → 执行
 * 3. 生成自然语言帮助回复（当用户输入非命令时）
 */
import { useAppStore } from '../../store/useAppStore';
import { parseRules, isLikelyCommand } from './rulesEngine';
import { planCommand } from './canvasPlanner';
import { executeCommand, logOperation } from './commandRegistry';
import {
  resolveAssistantModel,
  buildAssistantSystemPrompt,
  streamAssistantReply,
} from '../ai/assistantStream';
import type { BaseNodeData } from '../../types';
import type {
  CommandIntent,
  CommandPlan,
  CommandResult,
  CanvasContext,
  CanvasNodeSummary,
  AssistantStreamEvent,
} from '../../types/chat';

// ============================================
// Context builder
// ============================================

/**
 * 构建脱敏画布上下文（不包含 prompt/output 等隐私/大量内容）。
 */
export function buildCanvasContext(): CanvasContext {
  const store = useAppStore.getState();

  const nodes: CanvasNodeSummary[] = store.nodes.map((n) => {
    const data = n.data as BaseNodeData;
    return {
      id: n.id,
      type: (n.type as CanvasNodeSummary['type']) || 'ai-text',
      status: data.status || 'idle',
      displayId: data.displayId,
      selected: !!n.selected,
    };
  });

  return {
    projectId: store.currentProjectId ?? '',
    totalNodes: store.nodes.length,
    totalEdges: store.edges.length,
    selectedNodeIds: store.selectedNodeIds,
    nodes,
  };
}

// ============================================
// Pipeline result types
// ============================================

export interface PipelineResult {
  /** 回复给用户的消息文本 */
  reply: string;
  /** 是否成功执行了命令 */
  commandExecuted: boolean;
  /** 执行的命令结果（可能有多个 step） */
  commandResults: CommandResult[];
  /** 使用的解析来源 */
  parseSource: 'rule' | 'llm' | 'help';
}

// ============================================
// Pipeline
// ============================================

/**
 * 完整解析-规划-执行管线。
 *
 * 流程：
 * 1. 本地规则引擎快速解析
 * 2. 高置信度 → 直接规划执行
 * 3. 低置信度/无匹配 → 返回友好帮助文案
 *
 * （P0-A.2: LLM 云端解析路径由 assistantStream.ts 负责）
 */
export async function runAssistantPipeline(
  userMessage: string,
  conversationId: string,
): Promise<PipelineResult> {
  const store = useAppStore.getState();

  // Step 1: 本地规则引擎
  const rulesResult = parseRules(userMessage);

  if (rulesResult.hasHighConfidence && rulesResult.intents.length > 0) {
    // Step 2: 规划 & 执行（循环处理多个意图）
    const results: CommandResult[] = [];

    for (const intent of rulesResult.intents) {
      const { plan } = planCommand(intent);
      const result = await executeCommand(plan);

      // 记录操作日志
      logOperation({
        projectId: store.currentProjectId ?? '',
        conversationId,
        timestamp: Date.now(),
        commandId: intent.commandId,
        summary: plan.summary,
        targetNodeIds: result.affectedNodeIds,
        parseSource: 'rule',
        status: result.status,
        undoable: ['deleteNodes', 'undo', 'redo'].includes(intent.commandId),
      });

      results.push(result);
    }

    const allMessages = results.map((r) => r.message).join('\n');
    return {
      reply: allMessages || '操作完成',
      commandExecuted: true,
      commandResults: results,
      parseSource: 'rule',
    };
  }

  // Step 3: 无高置信度匹配 → 生成帮助回复
  const isCommandish = isLikelyCommand(userMessage);
  const canvasContext = buildCanvasContext();

  if (isCommandish) {
    // 看起来像命令但解析失败 → 提示
    return {
      reply: [
        '不太确定你想执行什么操作。你可以试试：',
        '',
        '· "选中 3 号节点" — 选中指定节点',
        '· "删除失败节点" — 批量清理',
        '· "查看画布状态" — 查看概览',
        '· "撤销" / "重做" — 撤销或恢复操作',
        '',
        '当前画布：' + canvasContext.totalNodes + ' 个节点，' + canvasContext.totalEdges + ' 条连线',
      ].join('\n'),
      commandExecuted: false,
      commandResults: [],
      parseSource: 'help',
    };
  }

  // 纯聊天 → 返回画布概况
  return {
    reply: [
      `当前画布共有 ${canvasContext.totalNodes} 个节点、${canvasContext.totalEdges} 条连线。`,
      '',
      '你可以用自然语言操作画布，例如：',
      '· "选中 1 号节点"',
      '· "查看失败节点"',
      '· "删除失败节点"',
      '· "撤销" / "重做"',
    ].join('\n'),
    commandExecuted: false,
    commandResults: [],
    parseSource: 'help',
  };
}

// ============================================
// Streaming pipeline
// ============================================

export interface StreamingPipelineCallbacks {
  /** 每次接收文本增量 */
  onTextDelta: (delta: string) => void;
  /** 流结束，传入完整文本和执行结果 */
  onComplete: (fullText: string, results: CommandResult[]) => void;
  /** 出错 */
  onError: (error: string) => void;
  /** 取消信号 */
  signal?: AbortSignal;
}

/**
 * 运行流式助手管线：
 * 1. 先试本地规则引擎（高速路径）
 * 2. 本地规则命中 → 直接返回规划/执行结果
 * 3. 本地规则未命中 → 通过 LLM 流式回复
 *
 * 注意：如果未配置助手模型，直接走本地管线。
 */
export async function runStreamingPipeline(
  userMessage: string,
  conversationId: string,
  callbacks: StreamingPipelineCallbacks,
): Promise<void> {
  // Step 1: 先尝试本地规则引擎
  const rulesResult = parseRules(userMessage);

  if (rulesResult.hasHighConfidence && rulesResult.intents.length > 0) {
    // 本地规则命中 → 直接执行
    const store = useAppStore.getState();
    const results: CommandResult[] = [];

    for (const intent of rulesResult.intents) {
      const { plan } = planCommand(intent);
      const result = await executeCommand(plan);

      logOperation({
        projectId: store.currentProjectId ?? '',
        conversationId,
        timestamp: Date.now(),
        commandId: intent.commandId,
        summary: plan.summary,
        targetNodeIds: result.affectedNodeIds,
        parseSource: 'rule',
        status: result.status,
        undoable: ['deleteNodes', 'undo', 'redo'].includes(intent.commandId),
      });

      results.push(result);
    }

    callbacks.onComplete(results.map((r) => r.message).join('\n'), results);
    return;
  }

  // Step 2: 检查是否有 LLM 模型配置
  if (!resolveAssistantModel()) {
    // 无模型 → 回退到本地管线
    const result = await runAssistantPipeline(userMessage, conversationId);
    callbacks.onComplete(result.reply, result.commandResults);
    return;
  }

  // Step 3: LLM 流式请求
  const systemPrompt = buildAssistantSystemPrompt();
  let fullContent = '';

  try {
    await streamAssistantReply({
      systemPrompt,
      userMessage,
      onEvent: (event: AssistantStreamEvent) => {
        switch (event.type) {
          case 'text.delta':
            fullContent += event.delta;
            callbacks.onTextDelta(event.delta);
            break;
          case 'error':
            callbacks.onError(event.message);
            break;
          // 其他事件静默处理
        }
      },
      signal: callbacks.signal,
    });

    // Step 4: 对 LLM 回复进行意图解析
    const llmResult = parseRules(fullContent);
    const results: CommandResult[] = [];

    if (llmResult.intents.length > 0) {
      const store = useAppStore.getState();

      for (const intent of llmResult.intents) {
        const { plan } = planCommand({ ...intent, confidence: intent.confidence * 0.85 });
        const result = await executeCommand(plan);

        logOperation({
          projectId: store.currentProjectId ?? '',
          conversationId,
          timestamp: Date.now(),
          commandId: intent.commandId,
          summary: plan.summary,
          targetNodeIds: result.affectedNodeIds,
          parseSource: 'llm',
          status: result.status,
          undoable: ['deleteNodes', 'undo', 'redo'].includes(intent.commandId),
        });

        results.push(result);
      }
    }

    callbacks.onComplete(fullContent, results);
  } catch (err) {
    if (fullContent) {
      callbacks.onComplete(fullContent, []);
    } else {
      callbacks.onError(err instanceof Error ? err.message : '流式请求失败');
    }
  }
}
