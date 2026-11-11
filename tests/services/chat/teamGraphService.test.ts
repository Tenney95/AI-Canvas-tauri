import { describe, expect, it } from 'vitest';
import { createTemplateTeamGraph, getReadyTeamGraphNodes, teamGraphInvalidation, validateTeamGraph } from '../../../src/services/chat/teams/teamGraphService';
import type { AgentTeamRun } from '../../../src/types/agentTeam';

describe('declarative team graph', () => {
  it('compiles all fixed templates and exposes independent reviews only after their source', () => {
    for (const template of ['outline', 'script', 'review', 'general'] as const) expect(() => validateTeamGraph(createTemplateTeamGraph(template))).not.toThrow();
    const graph = createTemplateTeamGraph('outline');
    const run = { version: 2, graph, stages: graph.nodes.map((node) => ({ id: node.id, status: 'pending' })) } as AgentTeamRun;
    expect(getReadyTeamGraphNodes(run).map((node) => node.id)).toEqual(['structure']);
    run.stages[0] = { ...run.stages[0], status: 'completed', artifactId: 'outline' };
    expect(getReadyTeamGraphNodes(run).map((node) => node.id)).toEqual(['continuity', 'dialogue']);
  });

  it('keeps script and general within the call budget while all four specialists review the same draft', () => {
    for (const [template, taskCount] of [['script', 7], ['general', 8]] as const) {
      const graph = createTemplateTeamGraph(template);
      expect(graph.nodes).toHaveLength(taskCount);
      const reviews = graph.nodes.filter((node) => node.kind === 'review');
      expect(reviews.map((node) => node.roleId).sort()).toEqual(['continuity', 'dialogue', 'director', 'storyboard']);
      expect(reviews.every((node) => node.sourceTaskId === 'draft' && node.dependsOn.length === 1 && node.dependsOn[0] === 'draft')).toBe(true);
      const decision = graph.nodes.find((node) => node.kind === 'decision')!;
      expect([...decision.dependsOn].sort()).toEqual(reviews.map((node) => node.id).sort());
      expect(decision.sourceTaskId).toBe('draft');
      expect(graph.nodes.find((node) => node.id === graph.finalTaskId)).toMatchObject({
        roleId: 'writer', kind: 'revision', sourceTaskId: 'draft', dependsOn: [decision.id],
      });
      const run = { version: 2, graph, stages: graph.nodes.map((node) => ({ id: node.id,
        status: node.kind === 'outline' || node.kind === 'draft' ? 'completed' : 'pending',
        artifactId: node.kind === 'outline' || node.kind === 'draft' ? `${node.id}-artifact` : undefined,
      })) } as AgentTeamRun;
      expect(getReadyTeamGraphNodes(run).map((node) => node.id).sort()).toEqual(reviews.map((node) => node.id).sort());
    }
  });

  it('uses four independent specialists for joint review while keeping outline review lightweight', () => {
    const graph = createTemplateTeamGraph('review');
    expect(graph.nodes).toHaveLength(5);
    const reviews = graph.nodes.filter((node) => node.kind === 'review');
    expect(reviews.map((node) => node.roleId).sort()).toEqual(['continuity', 'dialogue', 'director', 'storyboard']);
    expect(reviews.every((node) => !node.sourceTaskId && node.dependsOn.length === 0)).toBe(true);
    expect(graph.nodes.find((node) => node.id === graph.finalTaskId)).toMatchObject({
      roleId: 'editor', kind: 'decision', dependsOn: reviews.map((node) => node.id),
    });
    expect(createTemplateTeamGraph('outline').nodes.filter((node) => node.kind === 'review').map((node) => node.roleId))
      .toEqual(['continuity', 'dialogue']);
  });

  it('does not let director or storyboard bypass the manuscript and final-delivery contracts', () => {
    for (const roleId of ['director', 'storyboard'] as const) {
      expect(() => validateTeamGraph({ version: 1, finalTaskId: 'specialist', nodes: [
        { id: 'specialist', roleId, title: '专科意见', kind: 'review', dependsOn: [] },
      ] })).toThrow('审阅不能直接作为最终稿');
      const wrongSource = createTemplateTeamGraph('general');
      wrongSource.nodes.find((node) => node.roleId === roleId)!.sourceTaskId = 'structure';
      expect(() => validateTeamGraph(wrongSource)).toThrow('同一正文');
      const wrongKind = createTemplateTeamGraph('script');
      wrongKind.nodes.find((node) => node.roleId === roleId)!.kind = 'draft';
      expect(() => validateTeamGraph(wrongKind)).toThrow('角色');
    }
  });

  it('rejects cycles, mismatched review sources and disconnected paid work', () => {
    const cycle = createTemplateTeamGraph('outline');
    cycle.nodes[0].dependsOn = ['revision'];
    expect(() => validateTeamGraph(cycle)).toThrow('循环');
    const mismatch = createTemplateTeamGraph('general');
    mismatch.nodes.find((node) => node.id === 'continuity')!.sourceTaskId = 'structure';
    expect(() => validateTeamGraph(mismatch)).toThrow('同一正文');
    const disconnected = createTemplateTeamGraph('outline');
    disconnected.nodes.push({ id: 'unused', title: 'unused', roleId: 'writer', kind: 'draft', dependsOn: [] });
    expect(() => validateTeamGraph(disconnected)).toThrow('最终交付');
  });

  it('invalidates only the changed task and its descendants', () => {
    const graph = createTemplateTeamGraph('general');
    expect([...teamGraphInvalidation(graph, ['continuity'])].sort()).toEqual(['continuity', 'decision', 'revision']);
    expect(() => validateTeamGraph({ ...graph, script: 'arbitrary JS' })).toThrow();
  });

  it('requires an explicit body source when a review has a body ancestor', () => {
    const graph = createTemplateTeamGraph('outline');
    delete graph.nodes.find((node) => node.id === 'continuity')!.sourceTaskId;
    expect(() => validateTeamGraph(graph)).toThrow('显式指定');
  });
});
