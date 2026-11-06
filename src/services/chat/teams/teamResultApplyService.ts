/** 团队候选的分集应用：工具策略、字段条件保存与局部编辑会话共用一条链路。 */
import type { AgentTask } from '../../../types/agent';
import type { TeamApplicationReceipt, TeamEpisodeTarget, TeamInvocationContext } from '../../../types/agentTeam';
import { useAppStore } from '../../../store/useAppStore';
import { seriesOwnerId } from '../../../store/store.utils';
import { loadProjectData } from '../../fileService';
import { episodeTeamSourceSnapshot } from '../../seriesCreativeService';
import { assertEpisodeEditorReady, prepareEpisodeEditorRebase, withEpisodeEditorWrite } from '../../episodeEditorSessionService';
import { executeRegisteredAgentToolCall } from '../agentToolExecution';
import { prepareTeamTaskApplication, runAgentTask, transitionAgentTask, waitForAgentApproval } from '../agentTaskControl';
import { saveAgentTask } from '../agentTaskService';
import { getActiveConversationAgentTaskId, scheduleConversationAgentExecution } from '../agentScheduler';
import { registerAgentTool } from '../toolRegistry';
import { sanitizeDomainText } from '../subAgentMaterials';
import { hashTeamText, readTeamArtifactText } from './teamArtifactService';

const activeApplications = new Map<string, Promise<void>>();
const TEXT_FIELDS = new Set(['outline', 'script']);

function readTask(taskId: string): AgentTask {
  const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
  if (task?.executionKind !== 'team' || task.teamRun?.id !== taskId || !task.teamRun.resultArtifactId) {
    throw new Error('团队任务尚无可应用的最终候选');
  }
  return task;
}

function readTargetValue(target: TeamEpisodeTarget): string {
  const state = useAppStore.getState();
  const episode = state.projects.find((item) => item.id === target.episodeId);
  if (state.projectLoadStatus !== 'ready' || state.currentProjectId !== target.episodeId
    || !episode || episode.parentId !== target.seriesId || !TEXT_FIELDS.has(target.field)
    || state.switchingProjectName !== null || state.isCreatingProject || state.isReturningToStartPage) {
    throw new Error('请先回到任务绑定的原分集，再比较或应用团队成果');
  }
  return target.field === 'outline' ? episode.episodeOutline ?? '' : episode.episodeScript ?? '';
}

export async function captureEpisodeTeamContext(
  episodeId: string,
  field: TeamEpisodeTarget['field'],
): Promise<{ context: TeamInvocationContext; materials: string; originalText: string }> {
  const state = useAppStore.getState();
  const episode = state.projects.find((item) => item.id === episodeId);
  const ownerId = seriesOwnerId(state.projects, episodeId);
  const series = state.projects.find((item) => item.id === ownerId);
  if (!episode?.parentId || !series || episode.parentId !== series.id || !TEXT_FIELDS.has(field)
    || state.currentProjectId !== episodeId || state.projectLoadStatus !== 'ready') {
    throw new Error('请先打开要处理的准确分集');
  }
  assertEpisodeEditorReady(episodeId);
  const originalText = field === 'outline' ? episode.episodeOutline ?? '' : episode.episodeScript ?? '';
  const sourceSnapshot = episodeTeamSourceSnapshot(episode, field);
  const [expectedHash, sourceHash] = await Promise.all([hashTeamText(originalText), hashTeamText(sourceSnapshot)]);
  const target: TeamEpisodeTarget = { kind: 'episode', seriesId: series.id, episodeId, field, expectedHash,
    sourceHash,
    label: `${series.name} · ${episode.name} · ${field === 'outline' ? '本集大纲' : '本集剧本'}` };
  if (readTargetValue(target) !== originalText) throw new Error('保存后分集内容又有变化，请重新发起');
  const latest = useAppStore.getState().projects.find((item) => item.id === episodeId);
  if (!latest || episodeTeamSourceSnapshot(latest, field) !== sourceSnapshot) throw new Error('创作材料已变化，请重新发起');
  assertEpisodeEditorReady(episodeId);
  return {
    context: { source: 'script-workbench', target }, originalText,
    materials: JSON.stringify({ version: 1, untrusted: true, seriesName: series.name, episodeName: episode.name,
      outline: episode.episodeOutline ?? '', script: episode.episodeScript ?? '', creative: episode.episodeCreative ?? {} }),
  };
}

async function persistRunUpdate(taskId: string, application: TeamApplicationReceipt | undefined): Promise<void> {
  const task = readTask(taskId);
  useAppStore.getState().updateAgentTask(taskId, { teamRun: { ...task.teamRun!, application } });
  await saveAgentTask(readTask(taskId));
}

function targetForTask(task: AgentTask): TeamEpisodeTarget {
  const target = task.teamRun?.target;
  if (!target || target.kind !== 'episode' || !TEXT_FIELDS.has(target.field)) throw new Error('任务没有绑定可应用的分集字段');
  if (task.teamRun?.templateId === 'review') throw new Error('联合审稿只提供报告，不能作为剧本正文应用');
  return target;
}

async function executeResultWrite(taskId: string, restore: boolean, signal: AbortSignal): Promise<void> {
  const initial = readTask(taskId);
  const run = initial.teamRun!;
  const target = targetForTask(initial);
  const result = run.artifacts.find((item) => item.id === run.resultArtifactId);
  if (!result || !['outline', 'draft', 'revision'].includes(result.kind)) throw new Error('该团队产物不是可应用的正文');
  if (run.application && ['pending', 'restore-pending'].includes(run.application.status)) {
    throw new Error('上次保存状态尚未核对，请先核对保存状态，不要重复提交');
  }
  if ((!restore && run.application?.status === 'applied') || (restore && run.application?.status === 'restored')) return;
  if (restore && run.application?.status !== 'applied') throw new Error('尚无已应用版本可恢复');
  const original = run.artifacts.find((item) => item.id === run.application?.originalArtifactId)
    ?? run.artifacts.find((item) => item.kind === 'original');
  if (!original) throw new Error('任务缺少原稿恢复点，已阻止覆盖');
  const [resultText, originalText] = await Promise.all([
    readTeamArtifactText(initial.projectId, result), readTeamArtifactText(initial.projectId, original),
  ]);
  const [resultHash, originalHash] = await Promise.all([hashTeamText(resultText), hashTeamText(originalText)]);
  if (originalHash !== target.expectedHash) throw new Error('原稿恢复点与任务目标不一致，已阻止保存');
  const expectedHash = restore ? run.application!.targetHashAfter : target.expectedHash;
  const nextText = restore ? originalText : resultText;
  await withEpisodeEditorWrite(target.episodeId, async () => {
    if (signal.aborted) throw new Error('团队成果应用已取消');
    const currentText = readTargetValue(target);
    if (await hashTeamText(currentText) !== expectedHash) throw new Error('当前稿件已变化，团队成果已保留，请先比较差异');
    assertEpisodeEditorReady(target.episodeId);
    const rebaseEditors = prepareEpisodeEditorRebase(target.episodeId);
    const receipt: TeamApplicationReceipt = { ...run.application,
      status: restore ? 'restore-pending' : 'pending', artifactId: result.id, originalArtifactId: original.id,
      targetHashBefore: originalHash, targetHashAfter: resultHash,
      appliedAt: run.application?.appliedAt ?? Date.now(),
    };
    // 先持久化意图与恢复点；保存失败时保持待核对，不自动重放写操作。
    await persistRunUpdate(taskId, receipt);
    if (signal.aborted) throw new Error('保存前请求已取消，请核对原任务状态');
    const saved = await useAppStore.getState().updateEpisodeCreative(target.episodeId,
      target.field === 'outline' ? { outline: nextText } : { script: nextText }, {
        expected: { ...target, expectedHash },
        assertCurrent: () => { if (signal.aborted) throw new Error('请求已取消'); assertEpisodeEditorReady(target.episodeId); },
      });
    if (!saved) throw new Error('保存未确认成功，候选与恢复点已保留，请先核对保存状态');
    rebaseEditors();
    await persistRunUpdate(taskId, { ...receipt, status: restore ? 'restored' : 'applied',
      ...(restore ? { restoredAt: Date.now() } : {}),
    });
  });
}

export function registerTeamResultTools(): Array<() => void> {
  return ([false, true] as const).map((restore) => registerAgentTool<Record<string, never>>({
    id: restore ? 'agent_team_restore_result' : 'agent_team_apply_result',
    title: restore ? '恢复团队应用前原稿' : '应用团队最终候选',
    description: '仅对当前团队任务绑定的原分集字段条件保存；校验内容指纹与编辑草稿，不修改其他字段。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    effect: 'file_write',
    summarizeInput: () => restore ? '恢复原分集字段的应用前版本' : '应用已选择的团队最终候选到原分集字段',
    authorize: (context) => {
      const task = useAppStore.getState().agentTasks.find((item) => item.id === context.taskId);
      return task?.teamRun?.target && task.projectId === context.projectId
        && task.conversationId === context.conversationId && useAppStore.getState().currentProjectId === context.projectId
        ? { allowed: true } : { allowed: false, reason: '此工具只接受任务绑定的原分集，不接受模型指定其他目标' };
    },
    execute: async (context) => {
      try {
        await executeResultWrite(context.taskId, restore, context.signal);
        return { status: 'success', summary: restore ? '已恢复原稿并保存' : '团队候选已应用并保存',
          modelContent: JSON.stringify({ applied: !restore, restored: restore, taskId: context.taskId }) };
      } catch (error) {
        const summary = sanitizeDomainText(error instanceof Error ? error.message : '团队成果保存失败').slice(0, 400);
        return { status: 'error', summary, modelContent: summary, errorCode: 'TEAM_RESULT_NOT_SAVED', retryable: false };
      }
    },
  }));
}

async function dispatchResultWrite(taskId: string, restore: boolean): Promise<void> {
  const existing = activeApplications.get(taskId);
  if (existing) return existing;
  const operation = (async () => {
    const task = readTask(taskId);
    const target = targetForTask(task);
    readTargetValue(target);
    if (task.mode === 'plan') throw new Error('规划模式只提供建议，不能应用或恢复原稿');
    const status = task.teamRun!.application?.status;
    if ((!restore && status === 'applied') || (restore && status === 'restored')) return;
    if (status === 'pending' || status === 'restore-pending') throw new Error('请先核对上次保存状态');
    const tools = await import('../tools');
    await tools.ensureAgentToolsRegistered();
    let errorMessage: string | undefined;
    const activeConversationTaskId = getActiveConversationAgentTaskId(task.conversationId);
    if (activeConversationTaskId) throw new Error('本对话还有任务正在执行，请等待完成后再应用成果');
    prepareTeamTaskApplication(taskId);
    const outcome = await new Promise<AgentTask>((resolve, reject) => {
      scheduleConversationAgentExecution({ taskId, conversationId: task.conversationId,
        onError: reject,
        run: async () => {
          if (useAppStore.getState().agentTasks.find((item) => item.id === taskId)?.status !== 'queued') {
            reject(new Error('成果应用已被暂停或取消'));
            return;
          }
          resolve(await runAgentTask(taskId, async (signal) => {
            const executed = await executeRegisteredAgentToolCall({ taskId, signal,
              call: { callId: `${taskId}-${restore ? 'restore' : 'apply'}-${crypto.randomUUID()}`,
                toolId: restore ? 'agent_team_restore_result' : 'agent_team_apply_result', input: {} },
              transitionTask: transitionAgentTask, waitForApproval: waitForAgentApproval,
              policyMode: task.mode,
              onApprovalRequired: () => {
                const store = useAppStore.getState();
                store.setActiveConversation(task.conversationId);
                store.openChat();
                void import('./teamInvocationService').then(({ openTeamTaskInAssistant }) => openTeamTaskInAssistant(taskId))
                  .catch(() => useAppStore.getState().showToast('请在助手任务中心处理团队成果保存确认', 'error'));
              },
            });
            if (executed.summary.status !== 'success') {
              errorMessage = executed.summary.summary;
              return 'paused';
            }
            return 'completed';
          }));
        },
      });
    });
    if (errorMessage) throw new Error(errorMessage);
    if (outcome.status !== 'completed') throw new Error('成果应用未完成，候选已保留');
  })();
  activeApplications.set(taskId, operation);
  try { await operation; } finally { if (activeApplications.get(taskId) === operation) activeApplications.delete(taskId); }
}

export const applyTeamResult = (taskId: string): Promise<void> => dispatchResultWrite(taskId, false);
export const restoreTeamResult = (taskId: string): Promise<void> => dispatchResultWrite(taskId, true);

/** 只读核对持久化内容，不重新保存字段；用户必须再次明确发起尚未执行的应用。 */
export async function reconcileTeamResult(taskId: string): Promise<string> {
  if (activeApplications.has(taskId)) throw new Error('成果仍在保存，请等待完成后核对');
  const task = readTask(taskId);
  const target = targetForTask(task);
  const receipt = task.teamRun!.application;
  if (!receipt || !['pending', 'restore-pending'].includes(receipt.status)) return '当前没有待核对的成果保存';
  const inMemory = readTargetValue(target);
  const record = await loadProjectData(target.episodeId);
  if (!record || record.parentId !== target.seriesId) throw new Error('无法核对原分集保存记录');
  const persisted = target.field === 'outline' ? record.episodeOutline ?? '' : record.episodeScript ?? '';
  const [memoryHash, savedHash] = await Promise.all([hashTeamText(inMemory), hashTeamText(persisted)]);
  if (readTargetValue(target) !== inMemory) throw new Error('核对期间分集内容发生变化，请重新核对');
  if (memoryHash !== savedHash) throw new Error('当前编辑状态与保存记录不一致，请先处理保存问题，未重新应用成果');
  const restoring = receipt.status === 'restore-pending';
  if (savedHash === (restoring ? receipt.targetHashBefore : receipt.targetHashAfter)) {
    await persistRunUpdate(taskId, { ...receipt, status: restoring ? 'restored' : 'applied',
      ...(restoring ? { restoredAt: Date.now() } : {}),
    });
    return restoring ? '已核对原稿已保存恢复' : '已核对团队成果已保存';
  }
  if (savedHash === (restoring ? receipt.targetHashAfter : receipt.targetHashBefore)) {
    await persistRunUpdate(taskId, restoring ? { ...receipt, status: 'applied' } : undefined);
    return '已核对上次没有改动目标字段；如需保存，请再次明确应用，不会自动重投';
  }
  throw new Error('原分集已出现其他修改，保存状态不能自动判定；候选和恢复点已保留，请人工比较');
}
