/** 工作台创作复用常规 Agent 调度；只绑定明确分集，不切换画布。 */
import { useAppStore } from '../../store/useAppStore';
import type { AgentMode } from '../../types/agent';
import { resolveAssistantModel } from '../ai/assistantStream';
import { isWorkbenchAgentTaskInScope, readEpisodeWorkspaceScope } from '../episodeWorkspaceScope';
import { submitConversationMessage } from './conversationExecutionController';
import { t } from '../../i18n';

export function startWorkbenchAgentInvocation(input: {
  episodeId: string;
  content: string;
  mode?: AgentMode;
}): { taskId: string; conversationId: string } {
  const view = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('view');
  if (view && view !== 'main') throw new Error('请通过主窗口发起工作台创作任务');
  const state = useAppStore.getState();
  const scope = readEpisodeWorkspaceScope(state, input.episodeId);
  if (!scope) throw new Error('工作台分集已变化，请回到所属剧集后重试');
  const content = input.content.trim();
  if (!content || input.content.length > 30000) throw new Error('创作请求为空或超过 30000 字符');
  const mode = input.mode ?? 'collaborative';
  const workbenchTarget = { seriesId: scope.owner.id, episodeId: scope.episode.id };
  const existing = state.agentTasks.find((task) => {
    const conversation = state.conversations.find((entry) => entry.id === task.conversationId && !entry.deletedAt);
    return !task.parentTaskId && task.projectId === scope.episode.id && task.goal === content && task.mode === mode
      && ['queued', 'planning', 'running', 'waiting_tool', 'waiting_approval'].includes(task.status)
      && isWorkbenchAgentTaskInScope(state, task)
      && conversation?.agentMode === mode && conversation.workbenchTarget?.episodeId === scope.episode.id
      && conversation.workbenchTarget.seriesId === scope.owner.id;
  });
  let invocation = existing ? { taskId: existing.id, conversationId: existing.conversationId } : undefined;

  if (!invocation) {
    if (!resolveAssistantModel(scope.episode.id)) throw new Error('请先配置可用的对话文本模型，再开始智能调度');
    // 独立创作会话不继承其他对话的团队选择、工具授权或未发送草稿。
    const conversationId = state.createConversation(scope.episode.id, `${scope.episode.name} · 创作`);
    state.updateConversation(conversationId, { agentMode: mode, executionSelection: { kind: 'single' }, workbenchTarget });
    const result = submitConversationMessage({ content, conversationId, projectId: scope.episode.id,
      mode, executionSelection: { kind: 'single' }, workbenchTarget });
    if (result.status !== 'started' || !result.taskId) throw new Error('创作任务未能开始，请查看助手中的错误信息');
    invocation = { taskId: result.taskId, conversationId };
  }
  state.clearChatComposerDraft();
  if (useAppStore.getState().activeConversationId !== invocation.conversationId) {
    state.setActiveConversation(invocation.conversationId);
    void state.loadConversationMessages(invocation.conversationId);
  }
  state.focusAgentTask(invocation.taskId);
  state.setChatPanelView('chat');
  if (useAppStore.getState().chatPanelDetached) {
    const conversationId = invocation.conversationId;
    void import('./chatWindowLifecycle').then(({ openDetachedChatWindow }) => {
      const latest = useAppStore.getState();
      if (latest.currentProjectId !== state.currentProjectId || latest.activeConversationId !== conversationId || !latest.chatPanelDetached) return;
      return openDetachedChatWindow();
    }).catch(() => useAppStore.getState().showToast(t('打开独立助手窗口失败，创作任务已保留'), 'error'));
  } else state.openChat();
  return invocation;
}
