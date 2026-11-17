import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/types';

const driver = vi.hoisted(() => ({ models: [] as Array<{ value: string; provider: string; label: string; mediaKind: string; workflowId?: string }>,
  capabilities: {} as Record<string, { ratios?: string[]; resolutions?: string[]; supportsImageReference?: boolean; maxImageReferences?: number;
    qualities?: string[]; defaultQuality?: string; backgrounds?: string[]; defaultBackground?: string }> }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({ config: { providers: {} }, workflows: [] }) } }));
vi.mock('../../src/components/nodes/shared/defaultModels', async () => ({
  ...await vi.importActual<typeof import('../../src/components/nodes/shared/defaultModels')>('../../src/components/nodes/shared/defaultModels'),
  getMediaModelOptions: () => driver.models,
}));
vi.mock('../../src/services/ai/generateImage', () => ({
  characterImageChannel: () => 'standard', generateImage: vi.fn(), generateImagesBatch: vi.fn(), supportsCharacterPaintMask: () => false,
  supportsCharacterImageModel: (model: string, _provider: string, _config: unknown, count: number) => !count || driver.capabilities[model]?.supportsImageReference !== false,
}));
vi.mock('../../src/services/ai/mediaModelCapabilities', async () => ({
  ...await vi.importActual<typeof import('../../src/services/ai/mediaModelCapabilities')>('../../src/services/ai/mediaModelCapabilities'),
  resolveImageParameterCapability: (model: string) => driver.capabilities[model], resolveImageOutputsPerJob: () => 1,
}));
vi.mock('../../src/services/fileService', async () => ({
  ...await vi.importActual<typeof import('../../src/services/fileService')>('../../src/services/fileService'), isTauriEnv: () => true,
}));
vi.mock('../../src/services/nativeCharacterImageTask', () => ({ createNativeCharacterImageSubmissionGuard: vi.fn(), listNativeCharacterImageTasks: vi.fn(),
  reviewNativeCharacterImageTask: vi.fn(), runNativeCharacterImageTask: vi.fn(), isNativeCharacterImageSubmissionGuard: () => false }));
vi.mock('../../src/services/characterImageTaskRecovery', () => ({ characterImageConfigurationDigest: vi.fn(), recoverCharacterImageTask: vi.fn() }));
import { listCharacterVisualModels, resolveCharacterVisualParameters } from '../../src/services/characterVisualWorkbenchService';
import { isLegacyCharacterVisualCandidatePath, matchesOriginalCharacterVisualCandidatePath, type StoredCharacterVisualRun } from '../../src/services/characterVisualHistory';

beforeEach(() => { driver.models = []; driver.capabilities = {}; });
describe('character workbench image catalog', () => {
  it('keeps every configured image provider and workflow without a workbench provider whitelist', () => {
    driver.models = ['apimart', 'volcengine', 'cccapi', 'grsai', 'libapi', 'toapis', 'runninghub', 'muse', 'dreamina', 'general']
      .map((provider) => ({ value: `${provider}/image`, label: provider, provider, mediaKind: 'image' }));
    driver.models.push({ value: 'comfyui/workflow', label: 'workflow', provider: 'comfyui', mediaKind: 'image', workflowId: 'workflow' });
    driver.models.push({ value: 'video/model', label: 'video', provider: 'video', mediaKind: 'video' });
    const models = listCharacterVisualModels({ scope: 'global', characterId: 'character' }, 'appearance', 0, { providers: {} } as AppConfig, []);
    expect(models.map((model) => model.id)).toEqual(driver.models.filter((model) => model.mediaKind === 'image').map((model) => model.value));
    expect(models.find((model) => model.workflowId === 'workflow')?.id).toBe('comfyui/workflow');
  });

  it('enforces per-model reference limits at submission while preserving the full selection catalog', () => {
    driver.models = ['text-only', 'editing'].map((name) => ({ value: `apimart/${name}`, label: name, provider: 'apimart', mediaKind: 'image' }));
    driver.capabilities = { 'apimart/text-only': { supportsImageReference: false }, 'apimart/editing': { maxImageReferences: 2 } };
    const target = { scope: 'global' as const, characterId: 'character' }, config = { providers: {} } as AppConfig;
    expect(listCharacterVisualModels(target, 'appearance', 0, config, [])).toHaveLength(2);
    expect(listCharacterVisualModels(target, 'edit', 1, config, []).map((model) => model.id)).toEqual(['apimart/editing']);
    expect(listCharacterVisualModels(target, 'appearance', 3, config, [])).toHaveLength(0);
  });

  it('drops stale quality after a capability refresh and keeps an explicit API background default', () => {
    driver.models = [{ value: 'apimart/image', label: 'image', provider: 'apimart', mediaKind: 'image' }];
    driver.capabilities = { 'apimart/image': { qualities: ['medium'], defaultQuality: 'medium', backgrounds: ['transparent'], defaultBackground: 'transparent' } };
    const config = { providers: {} } as AppConfig;
    const [model] = listCharacterVisualModels({ scope: 'global', characterId: 'character' }, 'appearance', 0, config, []);
    expect(resolveCharacterVisualParameters(model, { imageQuality: 'high', imageBackground: '' }, config))
      .toMatchObject({ imageQuality: 'medium', imageBackground: '' });
  });
});

describe('character original format recovery paths', () => {
  const operationId = '11111111-1111-4111-8111-111111111111';
  const run: StoredCharacterVisualRun = {
    id: `character-visual-run-v1:project:owner:character:${operationId}`, operationId,
    name: '角色', sent: true, native: false, draft: false, fingerprint: 'request',
    target: { scope: 'project', ownerId: 'owner', characterId: 'character' }, operation: 'appearance',
    prompt: '人物形象', model: 'image', provider: 'general', createdAt: 1, status: 'completed', references: [], candidates: [],
  };
  it.each(['png', 'jpg', 'webp', 'gif', 'svg'])('retains %s candidates in legacy, native project and global recovery', (extension) => {
    const id = `${operationId}-1`, name = `character-visual-${id}.${extension}`;
    const candidate = { id, relativePath: `Library/${name}`, bytes: 10, digest: 'f'.repeat(64) };
    expect(matchesOriginalCharacterVisualCandidatePath(run, candidate)).toBe(true);
    expect(isLegacyCharacterVisualCandidatePath(candidate.relativePath)).toBe(true);
    expect(matchesOriginalCharacterVisualCandidatePath({ ...run, nativeLocal: true }, { ...candidate, relativePath: `imports/character-visual/${name}` })).toBe(true);
    expect(matchesOriginalCharacterVisualCandidatePath({ ...run, target: { scope: 'global', characterId: 'character' } },
      { ...candidate, relativePath: `${operationId}/${id}.${extension}` })).toBe(true);
    expect(matchesOriginalCharacterVisualCandidatePath(run, { ...candidate, relativePath: `Library/../${name}` })).toBe(false);
    expect(matchesOriginalCharacterVisualCandidatePath(run, { ...candidate, id: `${operationId}-other` })).toBe(false);
  });
});
