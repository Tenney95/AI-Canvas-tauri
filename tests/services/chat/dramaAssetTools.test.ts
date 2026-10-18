import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../src/store/useAppStore';
import { registerDramaAssetAgentTools } from '../../../src/services/chat/tools/dramaAssetTools';
import {
  clearAgentToolRegistryForTests,
  getAgentTool,
  type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';
import type { DramaCharacter } from '../../../src/types/dramaAssets';
import { emptyDramaAssetLibrary } from '../../../src/types/dramaAssets';

function character(overrides: Partial<DramaCharacter> = {}): DramaCharacter {
  return {
    kind: 'character',
    id: 'char_1',
    key: '沈砚',
    name: '沈砚',
    identity: '刑警',
    summary: '沉默寡言的刑警',
    visualNotes: '短发、疤',
    voiceNotes: '低沉沙哑，语速偏慢',
    importance: 'main',
    confirmed: true,
    createdAt: 1,
    updatedAt: 2,
    source: 'manual',
    primaryVoiceClipId: 'voice-1',
    voiceClips: [{
      id: 'voice-1',
      kind: 'timbre',
      label: '低沉男声',
      audioUrl: 'asset:///project/data/voice.mp3',
      transcript: '你终于来了。',
      createdAt: 1,
      updatedAt: 2,
    }],
    ...overrides,
  };
}

function context(): AgentToolContext {
  return { projectId: 'p1' } as AgentToolContext;
}

beforeEach(() => {
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'p1',
    dramaAssets: { ...emptyDramaAssetLibrary(), characters: [character()] },
  });
});

describe('drama asset agent tools', () => {
  function mediaNodes() {
    useAppStore.setState({ nodes: [
      { id: 'audio-1', type: 'source-audio', position: { x: 0, y: 0 }, data: {
        label: '参考声音', type: 'source-audio', audioUrl: 'asset:///private/voice.flac', assetId: 'audio-asset',
      } },
      { id: 'image-1', type: 'source-image', position: { x: 100, y: 0 }, data: {
        label: '全身图', type: 'source-image', imageUrl: 'asset:///private/image.png', assetId: 'image-asset',
      } },
    ] });
  }

  it('binds audio and image references to the requested character without changing the canvas', async () => {
    registerDramaAssetAgentTools();
    mediaNodes();
    const before = useAppStore.getState().nodes;
    const audio = getAgentTool('drama_voice_add')!;
    const image = getAgentTool('drama_reference_image_add')!;
    expect(audio.effect).toBe('asset_write');
    expect(image.effect).toBe('asset_write');
    const voiceResult = await audio.execute(context(), {
      assetId: 'char_1', nodeId: 'audio-1', label: '小满音色', transcript: '试听台词', makePrimary: true,
    });
    const imageResult = await image.execute(context(), { assetId: 'char_1', nodeId: 'image-1', kind: 'full_body', makePrimary: true });
    const voice = JSON.parse(voiceResult.modelContent);
    const reference = JSON.parse(imageResult.modelContent);
    expect(voiceResult.status).toBe('success');
    expect(imageResult.status).toBe('success');
    const card = useAppStore.getState().dramaAssets.characters[0];
    expect(card.voiceClips).toHaveLength(2);
    expect(card.primaryVoiceClipId).toBe(voice.clipId);
    expect(card.voiceClips?.find((clip) => clip.id === voice.clipId)).toMatchObject({
      sourceNodeId: 'audio-1', label: '小满音色', kind: 'timbre', transcript: '试听台词',
    });
    expect(card.primaryReferenceImageId).toBe(reference.referenceImageId);
    expect(voice.mention).toContain('#voice/');
    expect(reference.mention).toContain(`#${reference.referenceImageId}`);
    expect(voiceResult.modelContent + imageResult.modelContent).not.toContain('asset:///');
    expect(useAppStore.getState().nodes).toBe(before);
    const read = await getAgentTool('drama_asset_get')!.execute(context(), { assetId: 'char_1' });
    expect(JSON.parse(read.modelContent).referenceImages[0]).toMatchObject({ id: reference.referenceImageId, isPrimary: true });
  });

  it.each(['scene', 'prop'] as const)('binds an already generated %s image without copying media or changing the canvas', async (kind) => {
    registerDramaAssetAgentTools();
    mediaNodes();
    const result = await getAgentTool('drama_asset_upsert')!.execute(context(), { kind, name: '参考资产' });
    const assetId = JSON.parse(result.modelContent).id;
    const before = useAppStore.getState().nodes;
    const tool = getAgentTool('drama_reference_image_add')!;
    const input = { assetId, nodeId: 'image-1' };
    const bound = await tool.execute(context(), input);
    expect(bound.status).toBe('success');
    expect(JSON.parse(bound.modelContent)).toMatchObject({ assetId, kind, imageReady: true, reused: false,
      mention: `@drama{${assetId}:参考资产}` });
    expect(useAppStore.getState().nodes).toBe(before);
    const read = await getAgentTool('drama_asset_get')!.execute(context(), { assetId });
    expect(JSON.parse(read.modelContent)).toMatchObject({ imageNodeId: 'image-1', imageReady: true });
    expect(JSON.parse((await tool.execute(context(), input)).modelContent).reused).toBe(true);
    expect(bound.modelContent + read.modelContent).not.toContain('asset:///');
    expect((await getAgentTool('drama_voice_add')!.execute(context(), { assetId, nodeId: 'audio-1' })).status).toBe('error');
    useAppStore.getState().syncDramaAssetImageFromNode('image-1', 'updated.png');
    const list = kind === 'scene' ? useAppStore.getState().dramaAssets.scenes : useAppStore.getState().dramaAssets.props;
    expect(list[0].imageUrl).toBe('updated.png');
  });

  it.each(['drama_voice_add', 'drama_reference_image_add'])('reuses %s media and rejects wrong types, missing roles and stale projects', async (id) => {
    registerDramaAssetAgentTools();
    mediaNodes();
    const tool = getAgentTool(id)!;
    const nodeId = id === 'drama_voice_add' ? 'audio-1' : 'image-1';
    const input = { assetId: 'char_1', nodeId };
    const first = JSON.parse((await tool.execute(context(), input)).modelContent);
    const second = JSON.parse((await tool.execute(context(), input)).modelContent);
    expect(second).toEqual({ ...first, reused: true });
    const card = useAppStore.getState().dramaAssets.characters[0];
    expect(id === 'drama_voice_add' ? card.voiceClips : card.referenceImages).toHaveLength(id === 'drama_voice_add' ? 2 : 1);
    expect((await tool.execute(context(), { ...input, nodeId: nodeId === 'audio-1' ? 'image-1' : 'audio-1' })).status).toBe('error');
    expect((await tool.execute(context(), { ...input, nodeId: 'absent' })).status).toBe('error');
    expect((await tool.execute(context(), { ...input, assetId: 'absent' })).status).toBe('error');
    expect((await tool.execute({ ...context(), projectId: 'other' }, input)).status).toBe('error');
    expect((await tool.execute({ ...context(), baseRevision: -1 }, input)).status).toBe('error');
    const abort = new AbortController();
    abort.abort();
    expect((await tool.execute({ ...context(), signal: abort.signal }, input)).status).toBe('error');
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((node) => ({
      ...node, data: { ...node.data, audioUrl: undefined, imageUrl: undefined, thumbnailUrl: undefined },
    })) });
    expect((await tool.execute(context(), input)).status).toBe('error');
    expect(tool.authorize?.({ ...context(), projectId: 'other' }, { ...input, scope: 'global' })).toMatchObject({ allowed: false });
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties).not.toHaveProperty('path');
    expect(tool.inputSchema.properties).not.toHaveProperty('audioUrl');
  });

  it.each(['drama_voice_add', 'drama_reference_image_add'])('supports global %s without project node IDs and reports save failure', async (id) => {
    registerDramaAssetAgentTools();
    mediaNodes();
    // 没有素材索引 ID 的节点也必须幂等，不能只依赖 assetId 去重。
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((node) => ({
      ...node, data: { ...node.data, assetId: undefined },
    })) });
    useAppStore.setState({ globalCharacters: [character({ id: 'global-1', voiceClips: [] })] });
    const save = vi.fn(async (_scope, card: DramaCharacter) => {
      useAppStore.setState({ globalCharacters: [card] });
      return true;
    });
    useAppStore.setState({ saveCharacterCard: save });
    const tool = getAgentTool(id)!;
    const input = { scope: 'global', assetId: 'global-1', nodeId: id === 'drama_voice_add' ? 'audio-1' : 'image-1' };
    expect((await tool.execute(context(), input)).status).toBe('success');
    expect(JSON.parse((await tool.execute(context(), input)).modelContent).reused).toBe(true);
    const card = useAppStore.getState().globalCharacters[0];
    const media = id === 'drama_voice_add' ? card.voiceClips : card.referenceImages;
    expect(media).toHaveLength(1);
    expect(media?.[0].sourceNodeId).toBeUndefined();
    const read = await getAgentTool('drama_asset_get')!.execute(context(), { scope: 'global', assetId: 'global-1' });
    expect(JSON.parse(read.modelContent).mention).toBe('@drama{global/global-1:沈砚}');
    expect(JSON.parse((await tool.execute(context(), input)).modelContent).mention).toContain('@drama{global/global-1#');
    expect(useAppStore.getState().dramaAssets.characters[0].referenceImages).toBeUndefined();
    save.mockResolvedValueOnce(false);
    expect((await tool.execute(context(), input)).status).toBe('error');
    save.mockRejectedValueOnce(new Error('private-path-that-must-not-leak'));
    const failed = await tool.execute(context(), input);
    expect(failed.status).toBe('error');
    expect(failed.modelContent).not.toContain('private-path');
  });

  it('lists assets as read-only with mention strings and voice availability', async () => {
    const unregisters = registerDramaAssetAgentTools();
    const definition = getAgentTool('drama_asset_list');

    expect(definition?.effect).toBe('read');
    const result = await definition!.execute(context(), {});
    const payload = JSON.parse(result.modelContent ?? '{}');

    expect(result.status).toBe('success');
    expect(payload.assets).toEqual([expect.objectContaining({
      id: 'char_1',
      kind: 'character',
      name: '沈砚',
      mention: '@drama{char_1:沈砚}',
      voiceClipCount: 1,
      hasVoice: true,
      imageReady: false,
    })]);
    unregisters.forEach((unregister) => unregister());
  });

  it('returns the full brief including voice notes and clips', async () => {
    const unregisters = registerDramaAssetAgentTools();
    const definition = getAgentTool('drama_asset_get');

    const result = await definition!.execute(context(), { assetId: 'char_1' });
    const payload = JSON.parse(result.modelContent ?? '{}');

    expect(payload.brief).toContain('声音：低沉沙哑，语速偏慢');
    expect(payload.voiceClips).toEqual([expect.objectContaining({
      id: 'voice-1',
      isPrimary: true,
      transcript: '你终于来了。',
    })]);
    unregisters.forEach((unregister) => unregister());
  });

  it('refuses to read assets from another project', async () => {
    const unregisters = registerDramaAssetAgentTools();
    const definition = getAgentTool('drama_asset_list');

    expect(definition?.authorize?.({ projectId: 'other' } as AgentToolContext, {}))
      .toEqual(expect.objectContaining({ allowed: false }));
    unregisters.forEach((unregister) => unregister());
  });

  it('creates a project asset behind the asset_write approval', async () => {
    const unregisters = registerDramaAssetAgentTools();
    const definition = getAgentTool('drama_asset_upsert')!;

    expect(definition.effect).toBe('asset_write');
    const result = await definition.execute(context(), {
      kind: 'scene',
      name: '雨夜天台',
      summary: '决战发生地',
      timeOfDay: '深夜',
    });
    const payload = JSON.parse(result.modelContent ?? '{}');
    const created = useAppStore.getState().dramaAssets.scenes[0];

    expect(result.status).toBe('success');
    expect(created).toMatchObject({
      kind: 'scene',
      name: '雨夜天台',
      timeOfDay: '深夜',
      source: 'manual',
    });
    expect(payload.mention).toBe(`@drama{${created.id}:雨夜天台}`);
    unregisters.forEach((unregister) => unregister());
  });

  it('rejects fields that belong to another asset kind and unknown ids', async () => {
    const unregisters = registerDramaAssetAgentTools();
    const definition = getAgentTool('drama_asset_upsert')!;

    const crossKind = await definition.execute(context(), {
      kind: 'scene',
      name: '天台',
      identity: '刑警',
    });
    expect(crossKind.status).toBe('error');
    expect(crossKind.summary).toContain('identity');

    const missing = await definition.execute(context(), { kind: 'scene', assetId: 'scene-nope' });
    expect(missing.status).toBe('error');
    expect(useAppStore.getState().dramaAssets.scenes).toHaveLength(0);
    unregisters.forEach((unregister) => unregister());
  });

  it('patches an existing character without dropping its voice clips', async () => {
    const unregisters = registerDramaAssetAgentTools();

    const result = await getAgentTool('drama_asset_upsert')!.execute(context(), {
      kind: 'character',
      assetId: 'char_1',
      wardrobeDefault: '黑色风衣',
    });
    const updated = useAppStore.getState().dramaAssets.characters[0];

    expect(result.status).toBe('success');
    expect(updated.wardrobeDefault).toBe('黑色风衣');
    // 参考图 / 音色片段不在工具的字段范围里，改设定不能把它们冲掉
    expect(updated.voiceClips).toHaveLength(1);
    expect(updated.summary).toBe('沉默寡言的刑警');
    unregisters.forEach((unregister) => unregister());
  });

  it('deletes assets as a permanent delete', async () => {
    const unregisters = registerDramaAssetAgentTools();
    const definition = getAgentTool('drama_asset_delete')!;

    expect(definition.effect).toBe('permanent_delete');
    const result = await definition.execute(context(), { assetId: 'char_1' });

    expect(result.status).toBe('success');
    expect(useAppStore.getState().dramaAssets.characters).toHaveLength(0);
    unregisters.forEach((unregister) => unregister());
  });

  it('keeps the global character library to characters only', async () => {
    const unregisters = registerDramaAssetAgentTools();
    const definition = getAgentTool('drama_asset_upsert')!;

    expect(definition.authorize?.(
      { projectId: 'other' } as AgentToolContext,
      { scope: 'global', kind: 'scene', name: '天台' },
    )).toEqual(expect.objectContaining({ allowed: false }));
    // 全局角色库不属于任何项目，项目没加载也能写
    expect(definition.authorize?.(
      { projectId: 'other' } as AgentToolContext,
      { scope: 'global', kind: 'character', name: '沈砚' },
    )).toEqual(expect.objectContaining({ allowed: true }));
    unregisters.forEach((unregister) => unregister());
  });
});
