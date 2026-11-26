import { describe, expect, it } from 'vitest';
import { validateProjectModelTransferAggregate } from '../../src/services/indexedDb/projectModelBusinessRepository';
import type { ProjectModelTransferAggregate } from '../../src/types/projectModelTransfer';

describe('新项目聚合校验', () => {
  it('接纳旧五角色团队DTO且保留原值，不接受其他有损规范化', () => {
    const oldTeam = { version: 1 as const, name: '旧团队', roles: { architect: 'a', writer: 'b', continuity: 'c', dialogue: 'd', editor: 'e' },
      maxCalls: 8, maxTotalTokens: 240000, maxOutputChars: 16000 };
    const input: ProjectModelTransferAggregate = {
      project: { id: 'P', name: '独立项目', kind: 'standalone', createdAt: 1, updatedAt: 1, epoch: 0,
        dataFolder: 'folder-P', storageRootRef: 'root-P', storageBindings: [
          { rootRef: 'root-P', folderName: 'folder-P', sourceRecordIds: [], source: 'project-managed' },
        ] },
      content: { projectId: 'P', revisions: { source: 0, script: 0, storyGraph: 0, assets: 0 },
        standaloneCreative: { revision: 0, storageRootRef: 'root-P', teamProfileOverride: oldTeam as never } },
      episodes: [], episodeContents: [], previews: [], bindings: [],
      canvases: [{ id: 'canvas-P', projectId: 'P', episodeId: null, storageRootRef: 'root-P',
        nodes: [], edges: [], groups: [], epoch: 0, revision: 0, revisionScope: 'project' }],
    };
    expect(validateProjectModelTransferAggregate(input).content.standaloneCreative?.teamProfileOverride).toEqual(oldTeam);
    expect(input.content.standaloneCreative?.teamProfileOverride?.roles).not.toHaveProperty('director');
    const reader = { id: 'outline-reader', type: 'continuity', scope: 'outline', modelId: 'general/reader' } as const;
    const withReader = structuredClone(input);
    withReader.content.standaloneCreative!.teamProfileOverride = {
      ...oldTeam, roles: { ...oldTeam.roles, director: '', storyboard: '' }, readers: [reader],
    };
    expect(validateProjectModelTransferAggregate(withReader).content.standaloneCreative?.teamProfileOverride?.readers).toEqual([reader]);
    const missingWriter: Record<string, unknown> = { ...oldTeam.roles };
    delete missingWriter.writer;
    for (const invalid of [
      { ...oldTeam, maxCalls: 100 },
      { ...oldTeam, roles: { ...oldTeam.roles, writer: ' b ' } },
      { ...oldTeam, roles: { ...oldTeam.roles, director: null } },
      { ...oldTeam, roles: { ...oldTeam.roles, storyboard: 42 } },
      { ...oldTeam, roles: { ...oldTeam.roles, unknown: '' } },
      { ...oldTeam, roles: missingWriter },
      { ...oldTeam, readers: [reader, reader] },
      { ...oldTeam, readers: [{ ...reader, modelId: 'https://example.invalid' }] },
    ]) {
      const damaged = structuredClone(input);
      damaged.content.standaloneCreative!.teamProfileOverride = invalid as never;
      expect(() => validateProjectModelTransferAggregate(damaged)).toThrow('invalid-team-profile');
    }
  });
});
