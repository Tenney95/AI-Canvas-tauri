import { describe, expect, it } from 'vitest';
import { getMcpProjectContextRequirement, isMcpProjectContextCompatible } from '../../../src/services/mcp/mcpProjectContext';
import type { ProjectExpectedContext } from '../../../src/types/project';

const project: ProjectExpectedContext = { kind: 'project', schemaVersion: 2, modelGeneration: 0,
  projectId: 'owner', projectEpoch: 0, runtimeEpoch: 'runtime-1' };
const episode: ProjectExpectedContext = { ...project, kind: 'episode', episodeId: 'episode-a', episodeRevision: 2 };
const canvas: ProjectExpectedContext = { ...project, kind: 'canvas', canvasId: 'old-canvas-a', episodeId: 'episode-a', canvasEpoch: 0, canvasRevision: 4 };

describe('MCP scope requirements', () => {
  it('keeps project and episode edits distinct from physical Canvas effects', () => {
    expect(getMcpProjectContextRequirement({ id: 'project_rename', effect: 'canvas_write' })).toBe('project');
    expect(getMcpProjectContextRequirement({ id: 'series_split_episodes', effect: 'canvas_write' })).toBe('project');
    expect(getMcpProjectContextRequirement({ id: 'episode_move', effect: 'canvas_write' })).toBe('episode');
    expect(getMcpProjectContextRequirement({ id: 'episode_create_shotlist', effect: 'canvas_write' })).toBe('canvas');
    for (const context of [project, episode, canvas]) {
      expect(isMcpProjectContextCompatible({ id: 'series_update_script', effect: 'file_write' }, context)).toBe(true);
    }
    expect(isMcpProjectContextCompatible({ id: 'episode_update_script', effect: 'file_write' }, episode, { episodeId: 'episode-b' })).toBe(false);
    expect(isMcpProjectContextCompatible({ id: 'episode_update_script', effect: 'file_write' }, canvas, { episodeId: 'episode-a' })).toBe(false);
  });

  it('requires a Canvas for paid media, native director and plugin-node operations', () => {
    for (const id of ['media_generate', 'director_render_frame', 'plugin_node_execute']) {
      const tool = { id, effect: 'media_generation' as const };
      expect(isMcpProjectContextCompatible(tool, project, { delivery: 'chat' })).toBe(false);
      expect(isMcpProjectContextCompatible(tool, canvas, { delivery: 'chat' })).toBe(true);
    }
    expect(getMcpProjectContextRequirement({ id: 'mcp_operation_get', effect: 'read' })).toBe('project');
  });
});
