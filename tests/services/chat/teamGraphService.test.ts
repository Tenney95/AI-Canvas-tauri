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
