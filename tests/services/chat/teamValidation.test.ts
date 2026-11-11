import { describe, expect, it } from 'vitest';
import { getTeamAmendmentStageIds, getTeamSourceArtifact, validateTeamDecision, validateTeamReview } from '../../../src/services/chat/teams/teamValidation';
import { createDefaultTeamProfile, normalizeExecutionSelection, normalizeTeamProfile } from '../../../src/services/chat/teams/teamProfileService';
import { createTemplateTeamGraph } from '../../../src/services/chat/teams/teamGraphService';
import type { TeamArtifactReference, TeamDecisionReport, TeamReviewReport, TeamRoleId, TeamStageRun } from '../../../src/types/agentTeam';

const expected = { artifactId: 'draft-1', artifactHash: 'a'.repeat(64), source: '场景一：林舟推开门。\n他把钥匙递给妹妹。',
  requirements: '必须保留妹妹。', stageId: 'continuity' };
const report = () => ({ version: 1, artifactId: expected.artifactId, artifactHash: expected.artifactHash,
  findings: [{ id: 'continuity-1', severity: 'minor', location: '场景一第二句', evidence: '他把钥匙递给妹妹。',
    constraint: '质量建议', suggestion: '补充交出钥匙的动机。' }] });

describe('团队评审的版本和证据合同', () => {
  it('接纳原稿证据和逐字约束，允许无问题的独立报告', () => {
    expect(validateTeamReview(JSON.stringify(report()), expected).findings).toHaveLength(1);
    expect(validateTeamReview(JSON.stringify({ ...report(), findings: [] }), expected).findings).toEqual([]);
  });

  it('拒绝其他版本的报告，即使文字看起来相同', () => {
    expect(() => validateTeamReview(JSON.stringify({ ...report(), artifactHash: 'b'.repeat(64) }), expected)).toThrow();
  });

  it('拒绝编造的原文和用户未提出的硬约束', () => {
    const fabricated = report();
    fabricated.findings[0].evidence = '妹妹拒绝了钥匙。';
    expect(() => validateTeamReview(JSON.stringify(fabricated), expected)).toThrow();
    const inventedConstraint = report();
    inventedConstraint.findings[0].constraint = '主角必须死在结尾';
    expect(() => validateTeamReview(JSON.stringify(inventedConstraint), expected)).toThrow();
  });

  it('拒绝重复问题身份和额外执行指令字段', () => {
    const duplicate = report();
    duplicate.findings.push({ ...duplicate.findings[0] });
    expect(() => validateTeamReview(JSON.stringify(duplicate), expected)).toThrow();
    expect(() => validateTeamReview(JSON.stringify({ ...report(), command: 'write' }), expected)).toThrow();
  });

  it('裁决必须覆盖所有问题一次，不能用一个泛化结论代替另一位审阅者', () => {
    const decision = { version: 1, summary: '保留两个审阅维度的裁决', decisions: [
      { findingId: 'continuity-1', action: 'accept', reason: '动机交代不足' },
      { findingId: 'dialogue-1', action: 'reject', reason: '用户要求保留原对白' },
    ] };
    expect(validateTeamDecision(JSON.stringify(decision), ['continuity-1', 'dialogue-1']).decisions).toHaveLength(2);
    expect(() => validateTeamDecision(JSON.stringify({ ...decision, decisions: decision.decisions.slice(0, 1) }),
      ['continuity-1', 'dialogue-1'])).toThrow();
  });

  it('保留待澄清分歧，不将其自动转成同意', () => {
    const decision = validateTeamDecision(JSON.stringify({ version: 1, summary: '需要用户决定结局方向',
      decisions: [{ findingId: 'continuity-1', action: 'clarify', reason: '原设定没有说明是否和解' }],
    }), ['continuity-1']);
    expect(decision.decisions[0].action).toBe('clarify');
  });
});

describe('团队配置的受限合同', () => {
  it('执行选择不接受无效团队模板或权限字段', () => {
    expect(normalizeExecutionSelection({ kind: 'team', templateId: 'unknown', mode: 'autonomous' })).toEqual({ kind: 'single' });
    expect(normalizeExecutionSelection({ kind: 'team', templateId: 'review', mode: 'autonomous' })).toEqual({ kind: 'team', templateId: 'review' });
  });

  it('仅保留角色模型引用和合法预算，不透传凭据与地址', () => {
    const profile = normalizeTeamProfile({ roles: { writer: 'general/writer', unknown: 'foreign' }, maxCalls: 100,
      apiKey: 'should-not-survive', baseUrl: 'https://example.com' });
    expect(profile.roles.writer).toBe('general/writer');
    expect(profile.maxCalls).toBe(8);
    expect(profile).not.toHaveProperty('apiKey');
    expect(profile).not.toHaveProperty('baseUrl');
    expect(profile.roles).not.toHaveProperty('unknown');
  });

  it('新增角色使用明确默认模型，旧配置只补空值并保留已有模型和自定义任务图', () => {
    const defaults = createDefaultTeamProfile('general/default');
    expect(defaults.roles).toMatchObject({ director: 'general/default', storyboard: 'general/default' });
    const graph = createTemplateTeamGraph('outline');
    graph.nodes[0].title = '保留用户自定义结构任务';
    const roles = { architect: 'general/architect', writer: 'general/writer', continuity: 'general/continuity',
      dialogue: 'general/dialogue', editor: 'general/editor' };
    const profile = normalizeTeamProfile({ version: 1, name: '已有团队', roles, graph,
      roleExecutors: { writer: { kind: 'text-model', modelId: 'general/writer-override' } },
      maxCalls: 6, maxTotalTokens: 180000, maxOutputChars: 12000 });
    expect(profile.roles).toEqual({ ...roles, director: '', storyboard: '' });
    expect(profile.graph).toEqual(graph);
    expect(profile.roleExecutors).toEqual({ writer: { kind: 'text-model', modelId: 'general/writer-override' } });
    expect(profile).toMatchObject({ name: '已有团队', maxCalls: 6, maxTotalTokens: 180000, maxOutputChars: 12000 });
  });
});

describe('阶段依赖只读取已完成产物', () => {
  it('主笔pending时消费已完成的结构，主笔完成后审阅消费新稿', () => {
    const input: TeamArtifactReference = { id: 'input', kind: 'input', label: '材料', relativePath: 'input.json',
      sha256: 'a'.repeat(64), bytes: 1, createdAt: 1, parentArtifactIds: [] };
    const structure: TeamArtifactReference = { ...input, id: 'structure-artifact', kind: 'outline', stageId: 'structure' };
    const draft: TeamArtifactReference = { ...input, id: 'draft-artifact', kind: 'draft', stageId: 'draft' };
    const stages: TeamStageRun[] = [
      { id: 'structure', roleId: 'architect', title: '结构', modelId: 'model-a', status: 'completed',
        attempts: 1, artifactId: structure.id, usageKnown: false },
      { id: 'draft', roleId: 'writer', title: '主笔', modelId: 'model-b', status: 'pending', attempts: 0, usageKnown: false },
    ];
    const run = { inputArtifact: input, artifacts: [structure, draft], stages };
    expect(getTeamSourceArtifact(run).id).toBe(structure.id);
    stages[1] = { ...stages[1], status: 'completed', artifactId: draft.id };
    expect(getTeamSourceArtifact(run).id).toBe(draft.id);
    expect(getTeamSourceArtifact({ ...run, version: 2 }, 'structure').id).toBe(structure.id);
    expect(() => getTeamSourceArtifact({ ...run, version: 2, artifacts: [draft] }, 'structure')).toThrow('指定');
    expect(() => getTeamSourceArtifact({ ...run, artifacts: [structure] })).toThrow();
  });

  it('同稿的明确待澄清裁决只重做主编与修订，旧稿变化则全部失效', () => {
    const input: TeamArtifactReference = { id: 'input', kind: 'input', label: '材料', relativePath: 'input.json',
      sha256: 'a'.repeat(64), bytes: 1, createdAt: 1, parentArtifactIds: [] };
    const draft: TeamArtifactReference = { ...input, id: 'draft-1', kind: 'draft', stageId: 'draft' };
    const stages = (['structure', 'draft', 'continuity', 'dialogue', 'decision', 'revision'] as const).map<TeamStageRun>((id) => ({
      id, roleId: ({ structure: 'architect', draft: 'writer', continuity: 'continuity', dialogue: 'dialogue', decision: 'editor', revision: 'writer' } as Record<string, TeamRoleId>)[id],
      title: id, modelId: 'same-frozen-model', status: id === 'revision' ? 'pending' : 'completed',
      attempts: id === 'revision' ? 0 : 1, artifactId: id === 'draft' ? draft.id : undefined, usageKnown: false,
    }));
    const run = { stages, artifacts: [draft], inputArtifact: input };
    const reviews = [report(), { ...report(), findings: [{ ...report().findings[0], id: 'dialogue-1' }] }].map<TeamReviewReport>((review) => ({
      ...review, version: 1, findings: review.findings.map((finding) => ({ ...finding, severity: 'minor' })),
    }));
    const decision: TeamDecisionReport = { version: 1, summary: '需要确认人物动机', decisions: [
      { findingId: 'continuity-1', action: 'clarify', reason: '两种动机都符合现有设定' },
      { findingId: 'dialogue-1', action: 'reject', reason: '原对白是用户明确要求' },
    ] };
    expect(getTeamAmendmentStageIds(run, decision, reviews)).toEqual(['decision', 'revision']);
    expect(stages.find((stage) => stage.id === 'draft')?.status).toBe('completed');
    expect(getTeamAmendmentStageIds({ ...run, artifacts: [{ ...draft, sha256: 'b'.repeat(64) }] }, decision, reviews))
      .toEqual(stages.map((stage) => stage.id));
  });
});
