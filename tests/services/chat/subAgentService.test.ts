import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeAgentRoundMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/chat/agentRoundExecutor', () => ({
  executeAgentRound: executeAgentRoundMock,
}));

import { useAppStore } from '../../../src/store/useAppStore';
import {
  runSubAgent,
  SubAgentError,
  SUB_AGENT_TOOL_ALLOWLIST,
} from '../../../src/services/chat/subAgentService';
import { SUB_AGENT_LIMITS, type SubAgentProfile } from '../../../src/types/subAgent';
import { DEFAULT_AGENT_TASK_BUDGET, type AgentTask } from '../../../src/types/agent';
import { emptyDramaAssetLibrary } from '../../../src/types/dramaAssets';
import type { UserSkill } from '../../../src/types';
import type { AgentPackageSkill } from '../../../src/types/agentPackage';

function uploadedSkill(partial: Partial<UserSkill> = {}): UserSkill {
  return {
    id: 'skill-1',
    name: '剧本 Skill',
    description: '',
    fileName: 'SKILL.md',
    content: '---\nname: 剧本\n---\n按三幕结构分析。',
    sourceType: 'file',
    createdAt: 1,
    ...partial,
  };
}

function packageSkill(partial: Partial<AgentPackageSkill> = {}): AgentPackageSkill {
  return {
    id: 'ap-skill-1',
    name: '包内剧本 Skill',
    description: '分析剧本',
    fileName: 'SKILL.md',
    content: '---\nname: 包内剧本\n---\n包内角色正文：检查人物动机。',
    sourceType: 'agent-package',
    createdAt: 1,
    installationId: 'installation-1',
    packageId: 'drama-package',
    packageName: '剧本知识库',
    packageVersion: '1.0.0',
    packageContentHash: 'a'.repeat(64),
    sourceId: 'source-1',
    entryPath: 'skills/drama/SKILL.md',
    skillRoot: 'skills/drama',
    contentHash: 'b'.repeat(64),
    branch: 'shared',
    packageUserInvocable: true,
    packageAutoInvoke: false,
    mcpSkillReadEnabled: false,
    readOnly: true,
    ...partial,
  };
}

function profile(partial: Partial<SubAgentProfile> = {}): SubAgentProfile {
  return {
    id: 'profile-1',
    name: '剧本分析师',
    description: '分析剧本',
    instructions: '分析剧本结构。',
    materials: ['mentioned_nodes'],
    maxRounds: 2,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function parentTask(partial: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'parent-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    mode: 'collaborative',
    goal: '分析 @{node-a:剧本}',
    status: 'running',
    steps: [],
    modelRounds: 1,
    toolCallCount: 0,
    budget: { ...DEFAULT_AGENT_TASK_BUDGET },
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  } as AgentTask;
}

/** 让 executeAgentRound 只产出文本并立即收敛。 */
function respondWith(text: string) {
  executeAgentRoundMock.mockImplementation(async ({ totalToolResultChars }) => ({
    outcome: 'completed',
    fullText: text,
    totalToolResultChars,
  }));
}

beforeEach(() => {
  executeAgentRoundMock.mockReset();
  respondWith('分析结论');
  useAppStore.setState({
    agentTasks: [parentTask()],
    nodes: [{
      id: 'node-a',
      type: 'source-text',
      position: { x: 0, y: 0 },
      data: { type: 'source-text', label: '剧本', output: '第一场，小美出场。' },
    }] as never,
    dramaAssets: emptyDramaAssetLibrary(),
    userSkills: [],
    agentPackages: [],
    agentPackageSkills: [],
    currentProjectId: 'project-1',
  });
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('权限与嵌套边界', () => {
  it('子任务以 plan 模式和只读工具集创建', async () => {
    const result = await runSubAgent('parent-1', profile(), '分析结构', signal());
    const child = useAppStore.getState().agentTasks.find((t) => t.id === result.childTaskId)!;
    expect(child.mode).toBe('plan');
    expect(child.toolAllowlist).toEqual([...SUB_AGENT_TOOL_ALLOWLIST]);
    expect(child.parentTaskId).toBe('parent-1');
    expect(child.expertDepth).toBe(1);
  });

  it('只读工具集不含任何写工具或联网工具', () => {
    expect(SUB_AGENT_TOOL_ALLOWLIST).not.toContain('canvas_create_nodes');
    expect(SUB_AGENT_TOOL_ALLOWLIST).not.toContain('media_generate');
    expect(SUB_AGENT_TOOL_ALLOWLIST).not.toContain('web_search');
    expect(SUB_AGENT_TOOL_ALLOWLIST).not.toContain('file_write_text');
  });

  it('子智能体不能再派子智能体', async () => {
    useAppStore.setState({
      agentTasks: [parentTask({ id: 'child-1', parentTaskId: 'parent-1', expertDepth: 1 })],
    });
    await expect(runSubAgent('child-1', profile(), '再分析', signal()))
      .rejects.toThrow('不能再派出');
  });

  it('找不到父任务时报错', async () => {
    await expect(runSubAgent('missing', profile(), '分析', signal()))
      .rejects.toThrow('找不到');
  });

  it('超过单父任务数量上限后拒绝', async () => {
    const siblings = Array.from({ length: SUB_AGENT_LIMITS.maxTasksPerParent }, (_, index) =>
      parentTask({ id: `child-${index}`, parentTaskId: 'parent-1', expertDepth: 1 }));
    useAppStore.setState({ agentTasks: [parentTask(), ...siblings] });
    await expect(runSubAgent('parent-1', profile(), '分析', signal()))
      .rejects.toThrow(`最多派出 ${SUB_AGENT_LIMITS.maxTasksPerParent} 个`);
  });

  it('任务组预算耗尽后拒绝派出', async () => {
    const exhausted = parentTask({
      metrics: {
        inputTokens: DEFAULT_AGENT_TASK_BUDGET.maxTotalTokens * 2,
        outputTokens: 0,
      } as never,
    });
    useAppStore.setState({ agentTasks: [exhausted] });
    await expect(runSubAgent('parent-1', profile(), '分析', signal()))
      .rejects.toThrow('累计 token');
  });
});

describe('隔离上下文', () => {
  it('不加载会话历史，只发角色说明书、材料和分派任务', async () => {
    await runSubAgent('parent-1', profile(), '分析第一场', signal());
    const messages = executeAgentRoundMock.mock.calls[0][0].messages;
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('分析剧本结构。');
    expect(messages[0].content).toContain('没有任何写权限');
    expect(messages[1].content).toContain('第一场，小美出场。');
    expect(messages[2].content).toContain('分析第一场');
  });

  it('角色说明书优先取绑定 Skill 的正文', async () => {
    useAppStore.setState({
      userSkills: [uploadedSkill()],
    });
    await runSubAgent('parent-1', profile({ skillId: 'skill-1' }), '分析', signal());
    const system = executeAgentRoundMock.mock.calls[0][0].messages[0].content;
    expect(system).toContain('按三幕结构分析。');
    expect(system).not.toContain('name: 剧本');
  });

  it('从共享目录读取绑定的智能体包 Skill，显式绑定不依赖自动调用开关', async () => {
    useAppStore.setState({
      agentPackageSkills: [packageSkill({ manifest: { disableModelInvocation: true } })],
    });
    await runSubAgent('parent-1', profile({ skillId: 'ap-skill-1' }), '分析', signal());
    const system = executeAgentRoundMock.mock.calls[0][0].messages[0].content;
    expect(system).toContain('包内角色正文：检查人物动机。');
    expect(system).not.toContain('name: 包内剧本');
    expect(system).not.toContain('分析剧本结构。');
  });

  it.each<[string, AgentPackageSkill]>([
    ['Skill 文档声明', packageSkill({ manifest: { userInvocable: false } })],
    ['智能体包路由', packageSkill({ packageUserInvocable: false })],
  ])('%s禁止显式调用时回退到内联角色提示词', async (_label, skill) => {
    useAppStore.setState({ agentPackageSkills: [skill] });
    await runSubAgent('parent-1', profile({ skillId: skill.id }), '分析', signal());
    const system = executeAgentRoundMock.mock.calls[0][0].messages[0].content;
    expect(system).toContain('分析剧本结构。');
    expect(system).not.toContain('包内角色正文');
  });

  it('手动上传的 Skill 也遵守共享目录的显式调用规则', async () => {
    useAppStore.setState({ userSkills: [uploadedSkill({ manifest: { userInvocable: false } })] });
    await expect(runSubAgent(
      'parent-1', profile({ skillId: 'skill-1', instructions: undefined }), '分析', signal(),
    )).rejects.toThrow('不可用');
    expect(executeAgentRoundMock).not.toHaveBeenCalled();
  });

  it('包内 Skill 从共享目录撤下后，下次执行不使用之前的正文', async () => {
    useAppStore.setState({ agentPackageSkills: [packageSkill()] });
    await runSubAgent('parent-1', profile({ skillId: 'ap-skill-1' }), '分析', signal());
    useAppStore.setState({ agentPackageSkills: [] });
    await runSubAgent('parent-1', profile({ skillId: 'ap-skill-1' }), '再分析', signal());
    const system = executeAgentRoundMock.mock.calls[1][0].messages[0].content;
    expect(system).toContain('分析剧本结构。');
    expect(system).not.toContain('包内角色正文');
  });

  it('绑定的 Skill 被删除且没有内联提示词时报错', async () => {
    await expect(
      runSubAgent('parent-1', profile({ skillId: 'gone', instructions: undefined }), '分析', signal()),
    ).rejects.toThrow('已被删除');
  });

  it('绑定的 Skill 被删除但有内联提示词时降级使用后者', async () => {
    await runSubAgent('parent-1', profile({ skillId: 'gone' }), '分析', signal());
    expect(executeAgentRoundMock.mock.calls[0][0].messages[0].content)
      .toContain('分析剧本结构。');
  });
});

describe('执行与产出', () => {
  it('成功后写入结果并标记完成', async () => {
    const result = await runSubAgent('parent-1', profile(), '分析', signal());
    expect(result.result).toBe('分析结论');
    const child = useAppStore.getState().agentTasks.find((t) => t.id === result.childTaskId)!;
    expect(child.status).toBe('completed');
    expect(child.resultSummary).toBe('分析结论');
    expect(child.steps).toHaveLength(1);
  });

  it('轮数上限内收敛，不超过配置轮数', async () => {
    executeAgentRoundMock.mockImplementation(async ({ totalToolResultChars }) => ({
      outcome: 'continue',
      fullText: '中间结果',
      totalToolResultChars,
    }));
    await runSubAgent('parent-1', profile({ maxRounds: 3 }), '分析', signal());
    expect(executeAgentRoundMock).toHaveBeenCalledTimes(3);
  });

  it('产出为空时标记失败而不是静默成功', async () => {
    respondWith('   ');
    await expect(runSubAgent('parent-1', profile(), '分析', signal()))
      .rejects.toThrow('没有返回任何结果');
    const child = useAppStore.getState().agentTasks.find((t) => t.parentTaskId === 'parent-1')!;
    expect(child.status).toBe('failed');
  });

  it('超长产出按上限截断', async () => {
    respondWith('a'.repeat(SUB_AGENT_LIMITS.resultChars + 500));
    const result = await runSubAgent('parent-1', profile(), '分析', signal());
    expect(result.truncated).toBe(true);
    expect(result.result).toContain('已截断');
  });

  it('持久化摘要不超过上限', async () => {
    respondWith('b'.repeat(SUB_AGENT_LIMITS.resultChars));
    const result = await runSubAgent('parent-1', profile(), '分析', signal());
    const child = useAppStore.getState().agentTasks.find((t) => t.id === result.childTaskId)!;
    expect(child.resultSummary!.length).toBeLessThanOrEqual(SUB_AGENT_LIMITS.persistedResultChars);
  });

  it('模型出错时子任务标记 failed 并抛出 SubAgentError', async () => {
    executeAgentRoundMock.mockRejectedValue(new Error('模型不可用'));
    await expect(runSubAgent('parent-1', profile(), '分析', signal()))
      .rejects.toBeInstanceOf(SubAgentError);
    const child = useAppStore.getState().agentTasks.find((t) => t.parentTaskId === 'parent-1')!;
    expect(child.status).toBe('failed');
    expect(child.errorCode).toBe('SUB_AGENT_MODEL_ERROR');
  });

  it('父任务停止时子任务级联标记 stopped', async () => {
    const controller = new AbortController();
    executeAgentRoundMock.mockImplementation(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    await expect(runSubAgent('parent-1', profile(), '分析', controller.signal)).rejects.toThrow();
    const child = useAppStore.getState().agentTasks.find((t) => t.parentTaskId === 'parent-1')!;
    expect(child.status).toBe('stopped');
    expect(child.errorCode).toBe('SUB_AGENT_STOPPED');
  });

  it('审批一旦被触发即视为权限收窄失效，直接失败', async () => {
    executeAgentRoundMock.mockImplementation(async ({ waitForApproval }) => {
      await waitForApproval('approval-1', signal());
      return { outcome: 'completed', fullText: '不该到这里', totalToolResultChars: 0 };
    });
    await expect(runSubAgent('parent-1', profile(), '分析', signal()))
      .rejects.toThrow('不允许发起需要确认的操作');
  });
});
