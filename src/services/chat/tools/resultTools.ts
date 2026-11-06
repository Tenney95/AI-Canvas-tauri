import { registerAgentTool } from '../toolRegistry';
import { AGENT_RESULT_PAGE_CHARS, readAgentResult } from '../agentResultService';

export function registerResultAgentTools(): Array<() => void> {
  return [registerAgentTool<{ resultId: string; offset?: number; limit?: number }>({
    id: 'agent_result_read', title: '读取工具结果片段',
    description: '按不透明 resultId 读取本项目、本对话和本任务的工具结果片段。结果过期或原授权撤销时须用原工具重新读取，不能传路径。',
    effect: 'read',
    inputSchema: { type: 'object', required: ['resultId'], additionalProperties: false, properties: {
      resultId: { type: 'string', minLength: 43, maxLength: 43 },
      offset: { type: 'integer', minimum: 0, maximum: 1000000 },
      limit: { type: 'integer', minimum: 1, maximum: AGENT_RESULT_PAGE_CHARS },
    } },
    summarizeInput: (input) => `读取结果 ${input.resultId}，偏移 ${input.offset ?? 0}`,
    execute: async (context, input) => {
      try {
        const page = await readAgentResult(context, input.resultId, input.offset, input.limit);
        return { status: 'success', summary: `已读取结果 ${page.offset}-${page.nextOffset} 字（共 ${page.totalChars} 字）`,
          modelContent: JSON.stringify({ ...page, untrusted: true }), truncated: !page.eof };
      } catch (error) {
        return { status: 'error', summary: error instanceof Error ? error.message : '结果不可读取',
          modelContent: '结果不可读取，请按原始授权使用原工具重新读取。', errorCode: 'AGENT_RESULT_UNAVAILABLE', retryable: false };
      }
    },
  })];
}
