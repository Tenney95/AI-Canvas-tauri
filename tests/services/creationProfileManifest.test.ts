import { describe, expect, it } from 'vitest';
import { creationProfileSelection, normalizeCreationProfileSelection, parseCreationProfile } from '../../src/services/creationProfiles/creationProfileManifest';
import { createDefaultTeamProfile } from '../../src/services/chat/teams/teamProfileService';
import { configWithoutSecrets } from '../../src/services/configPatch';

const fixture = () => ({ schemaVersion: 1, id: 'script-team', version: '1.0.0', name: '剧本团队',
  pluginRefs: [], agentPackageRefs: [], skillRefs: [], contextPolicyRef: 'explicit-materials' });

describe('creation profile import contract', () => {
  it('pins a deterministic normalized document without embedding implementations', async () => {
    const profile = parseCreationProfile({ ...fixture(), teamTemplateId: 'general', teamProfile: createDefaultTeamProfile('general/text') });
    const selected = await creationProfileSelection(profile);
    expect(selected).toMatchObject({ id: 'script-team', version: '1.0.0', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await creationProfileSelection(parseCreationProfile(JSON.stringify(profile)))).toEqual(selected);
    expect((await creationProfileSelection({ ...profile, name: '新版团队' })).sha256).not.toBe(selected.sha256);
  });

  it('rejects keys, connection addresses, executable hooks and absolute paths at import', () => {
    for (const extra of [{ apiKey: 'fixture' }, { source: 'run()' }, { hooks: [] }, { policy: 'autonomous' }, { cwd: 'root' }]) {
      expect(() => parseCreationProfile({ ...fixture(), ...extra })).toThrow();
    }
    expect(() => parseCreationProfile({ ...fixture(), name: 'F:\\private\\file' })).toThrow();
    expect(() => parseCreationProfile({ ...fixture(), teamTemplateId: 'general', teamProfile: { ...createDefaultTeamProfile(), name: 'https://example.invalid' } })).toThrow();
    expect(() => configWithoutSecrets({ creationProfiles: [{ ...fixture(), secret: 'fixture' }] })).toThrow();
  });

  it('bounds references and refuses unknown graph or executor contracts', () => {
    expect(() => parseCreationProfile({ ...fixture(), skillRefs: Array.from({ length: 5 }, (_, index) => ({ skillId: `skill-${index}` })) })).toThrow();
    expect(() => parseCreationProfile({ ...fixture(), pluginRefs: [{ pluginId: 'p', revisionDigest: 'bad' }] })).toThrow();
    expect(() => parseCreationProfile({ ...fixture(), skillRefs: [{ skillId: 'a' }, { skillId: 'a' }] })).toThrow();
    const teamProfile = { ...createDefaultTeamProfile('text'), roleExecutors: { writer: { kind: 'external-agent', providerId: 'shell', modelId: 'text' } } };
    expect(() => parseCreationProfile({ ...fixture(), teamTemplateId: 'general', teamProfile })).toThrow();
    expect(() => normalizeCreationProfileSelection({ id: 'a', version: '1.0.0', sha256: 'a'.repeat(64), path: 'hidden' })).not.toThrow();
    expect(normalizeCreationProfileSelection({ id: 'a', version: '1.0.0', sha256: 'a'.repeat(64), path: 'hidden' })).toBeUndefined();
  });
});
