import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreationProfile } from '../../src/types/creationProfile';
import { creationProfileSelection } from '../../src/services/creationProfiles/creationProfileManifest';

const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => fixture.state } }));
vi.mock('../../src/services/ai/assistantStream', () => ({ resolveAssistantModel: (_project: string, id: string) => id === 'text' ? {} : undefined }));
vi.mock('../../src/services/plugins/pluginHealthService', () => ({ inspectPluginHealth: vi.fn(async () => ({ state: 'ready' })) }));
vi.mock('../../src/services/chat/externalAgents/externalAgentRegistry', () => ({ getExternalAgentStatus: vi.fn(async () => ({ available: false, models: [] })) }));
import { assertCreationProfileSnapshot, captureCreationProfile, intersectCreationTools, previewCreationProfile, saveCreationProfile } from '../../src/services/creationProfiles/creationProfileService';

const profile = (): CreationProfile => ({ schemaVersion: 1, id: 'team', version: '1.0.0', name: '团队',
  pluginRefs: [], agentPackageRefs: [], skillRefs: [], contextPolicyRef: 'explicit-materials' });

beforeEach(() => {
  fixture.state = { config: { creationProfiles: [profile()] }, installedPlugins: [], agentPackages: [], userSkills: [], agentPackageSkills: [],
    updateConfig: vi.fn((partial: Record<string, unknown>) => { fixture.state.config = { ...(fixture.state.config as object), ...partial }; }),
    saveConfig: vi.fn(async () => {}),
  };
});

describe('creation profile preparation', () => {
  it('reports missing requirements without installing, enabling or invoking a model', async () => {
    const preview = await previewCreationProfile({ ...profile(), pluginRefs: [{ pluginId: 'missing', revisionDigest: 'a'.repeat(64) }], skillRefs: [{ skillId: 'missing-skill' }] }, 'p1');
    expect(preview.issues).toHaveLength(2);
    expect(fixture.state.updateConfig).not.toHaveBeenCalled();
    expect(fixture.state.saveConfig).not.toHaveBeenCalled();
  });

  it('freezes selected identity and refuses silent upgrades or removal', async () => {
    const selected = await creationProfileSelection(profile());
    const captured = await captureCreationProfile(selected, 'p1');
    expect(captured.snapshot?.contextPolicyRef).toBe('explicit-materials');
    fixture.state.config = { creationProfiles: [{ ...profile(), description: 'changed' }] };
    await expect(captureCreationProfile(selected, 'p1')).rejects.toThrow('内容已变化');
    fixture.state.config = { creationProfiles: [] };
    expect(() => assertCreationProfileSnapshot(captured.snapshot)).not.toThrow();
    await expect(captureCreationProfile(selected, 'p1')).rejects.toThrow('移除或升级');
  });

  it('only narrows tool permissions and rolls back its catalog when persistence fails', async () => {
    expect(intersectCreationTools(['read', 'write'], ['read', 'new'])).toEqual(['read']);
    expect(intersectCreationTools(undefined, [])).toEqual([]);
    (fixture.state.saveConfig as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk'));
    await expect(saveCreationProfile({ ...profile(), id: 'second' })).rejects.toThrow('disk');
    expect((fixture.state.config as { creationProfiles: CreationProfile[] }).creationProfiles.map((entry) => entry.id)).toEqual(['team']);
  });
});
