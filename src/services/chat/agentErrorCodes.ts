/**
 * Agent 稳定错误码与用户可理解的恢复建议（P3-E2）。
 *
 * 错误码在 Runtime、Context Manager、工具和策略层稳定复用；
 * UI 通过 getAgentRecoveryHint 把错误码翻译成用户能看懂的处理建议。
 */

export interface AgentRecoveryHint {
  /** 简短标题 */
  title: string;
  /** 用户可执行的下一步建议 */
  hint: string;
}

export const AGENT_ERROR_HINTS: Record<string, AgentRecoveryHint> = {
  // 运行与停止
  AGENT_STOPPED: { title: '已停止', hint: '任务已停止。如需重试请点击继续或重新发送消息。' },
  AGENT_RUNTIME_ERROR: { title: '运行出错', hint: '任务执行时出错，可点击继续重试。' },
  AGENT_EXECUTION_FAILED: { title: '执行失败', hint: '任务未完成，可点击继续重试。' },
  AGENT_TOOL_EXCEPTION: { title: '工具异常', hint: '某个工具调用失败，可点击继续让助手重新规划。' },

  // 上下文预算
  CONTEXT_BUDGET_EXHAUSTED: { title: '上下文接近上限', hint: '任务上下文过大，建议切换到更大上下文窗口的模型后继续。' },
  CONTEXT_COMPRESSION_FAILED: { title: '上下文压缩失败', hint: '请检查助手模型是否可用，然后点击继续。' },
  CONTEXT_INPUT_TOO_LARGE: { title: '输入过大', hint: '请精简当前消息，或更换上下文更大的模型。' },

  // 继续前校验
  AGENT_RESUME_TASK_NOT_FOUND: { title: '任务不存在', hint: '该任务已不存在，无法继续。' },
  AGENT_RESUME_NOT_RESUMABLE: { title: '状态不可继续', hint: '任务当前状态不支持继续。' },
  AGENT_RESUME_PROJECT_NOT_ACTIVE: { title: '项目未加载', hint: '请先切回该任务所属的项目，再点击继续。' },
  AGENT_RESUME_CONVERSATION_GONE: { title: '会话已删除', hint: '来源对话不存在或已删除，无法继续该任务。' },
  AGENT_RESUME_NO_MESSAGE: { title: '消息缺失', hint: '找不到对应的助手消息，请重新发送消息。' },
};

export function getAgentRecoveryHint(code?: string): AgentRecoveryHint | undefined {
  return code ? AGENT_ERROR_HINTS[code] : undefined;
}
