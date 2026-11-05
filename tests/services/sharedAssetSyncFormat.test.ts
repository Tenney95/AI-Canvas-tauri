/**
 * sharedAssetSyncFormat — 回归测试：共享项目资产格式。
 */
import { describe, expect, it } from 'vitest';
import type { DramaAssetLibrary, DramaCharacter, DramaProp, DramaScene } from '../../src/types/dramaAssets';
import { buildDramaActionMentionId, buildDramaMentionId, buildDramaVoiceMentionId } from '../../src/types/dramaAssets';
import type { SharedSyncFilePayload, SharedSyncMedia, SharedSyncRevision } from '../../src/types/assetSync';
import { getSharedAssetSyncDependencies, getSharedAssetSyncMediaIds, parseSharedAssetSyncDraft, parseSharedAssetSyncRevision,
  restoreSharedAssetSyncText, restoreSharedDramaAsset, serializeSharedDramaAsset, sharedSyncMediaToken } from '../../src/services/sharedAssetSyncFormat';
import { preferDramaLibraryReferences } from '../../src/services/dramaAssetPrompt';

const media: SharedSyncMedia[] = [
  { id: 'image', kind: 'image', extension: 'png', sha256: 'a'.repeat(64), bytes: 12 },
  { id: 'audio', kind: 'audio', extension: 'wav', sha256: 'b'.repeat(64), bytes: 20 },
  { id: 'video', kind: 'video', extension: 'mp4', sha256: 'c'.repeat(64), bytes: 30 },
];

function character(): DramaCharacter {
  return { id: 'local-card', kind: 'character', name: '人物甲', key: '人物甲', summary: '简介', visualNotes: '',
    importance: 'main', source: 'manual', confirmed: true, createdAt: 1, updatedAt: 2, identity: '主角',
    imageUrl: 'asset://localhost/project/image.png', assetId: 'local-image', imageNodeId: 'node-image',
    referenceImages: [{ id: 'ref', kind: 'avatar', imageUrl: 'asset://localhost/project/image.png', assetId: 'local-image',
      sourceNodeId: 'node-image', prompt: '参考图', createdAt: 1, updatedAt: 2 }],
    primaryReferenceImageId: 'ref', avatarReferenceImageId: 'ref', avatarCrop: { x: 0, y: 0, width: 1, height: 1 },
    voiceClips: [{ id: 'voice', kind: 'timbre', assetId: 'local-audio', audioUrl: 'asset://localhost/project/voice.wav',
      transcript: '主音色', createdAt: 1, updatedAt: 2 }], primaryVoiceClipId: 'voice',
    actions: [{ id: 'action', category: 'walking', name: '行走', prompt: '向前走', createdAt: 1, updatedAt: 2,
      media: [{ id: 'action-image', kind: 'gif', name: '姿势', assetId: 'local-image', url: 'asset://localhost/project/image.png', createdAt: 1, updatedAt: 2 },
        { id: 'action-video', kind: 'video', name: '动作', assetId: 'local-video', url: 'asset://localhost/project/action.mp4', createdAt: 1, updatedAt: 2 }] }],
  };
}
const mapping = {
  memberId: (kind: string, localId: string) => `${kind}-${localId}`,
  mediaId: async (source: { assetId?: string }) => source.assetId!.slice('local-'.length),
};

function revision(payload: SharedSyncRevision['payload'], files = media): SharedSyncRevision {
  return { format: 'ai-canvas-shared-asset', version: 1, libraryId: 'library', sharedProjectId: 'project',
    sharedAssetId: 'shared-card', revisionId: 'revision', operationId: 'operation', createdAt: 3, payload, media: files };
}

describe('共享项目资产格式', () => {
  it('格式诊断给出稳定字段和原因，不回显损坏值', async () => {
    const payload = await serializeSharedDramaAsset(character(), 'shared-card', mapping);
    const value = revision(payload);
    for (const [broken, fieldPath, reason] of [
      [{ ...value, sharedAssetId: 'private/path-value' }, 'sharedAssetId', 'invalidIdentity'],
      [{ ...value, media: [{ ...value.media[0], extension: 'private/path-value' }, ...value.media.slice(1)] }, 'media[0].kind/extension', 'invalidMediaType'],
      [{ ...value, media: [{ ...value.media[0], sha256: 'private/path-value' }, ...value.media.slice(1)] }, 'media[0]', 'invalidMediaDigestOrSize'],
    ] as const) {
      let failure: unknown;
      try { parseSharedAssetSyncRevision(broken); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).cause).toEqual({ reason, fieldPath, stage: 'format' });
      expect((failure as Error).message).not.toContain('private/path-value');
    }
  });

  it('角色武器使用顶层卡片映射，单卡修订允许武器位于另一个修订', async () => {
    const source = { ...character(), weaponIds: ['local-sword', 'local-bow'] };
    const payload = await serializeSharedDramaAsset(source, 'shared-card', {
      ...mapping, mapWeaponId: (value) => value.replace('local-', 'shared-'),
    });
    expect(parseSharedAssetSyncRevision(revision(payload)).payload).toMatchObject({
      data: { weaponIds: ['shared-sword', 'shared-bow'] },
    });
    const restored = restoreSharedDramaAsset(payload, 'other-card', {
      memberId: (_kind, value) => `other-${value}`,
      mapWeaponId: (value) => value.replace('shared-', 'other-'),
      mediaById: new Map(media.map((entry) => [entry.id, { assetId: `other-${entry.id}`,
        relativePath: `Library/${entry.id}.${entry.extension}`, url: `asset://localhost/Library/${entry.id}.${entry.extension}` }])),
    }) as DramaCharacter;
    expect(restored.weaponIds).toEqual(['other-sword', 'other-bow']);
    expect(source.weaponIds).toEqual(['local-sword', 'local-bow']);
    expect(getSharedAssetSyncDependencies(payload)).toEqual(['shared-sword', 'shared-bow']);
  });

  it('武器绑定缺少映射、重复、越界或使用全局身份时拒绝共享', async () => {
    const source = { ...character(), weaponIds: ['local-sword'] };
    await expect(serializeSharedDramaAsset(source, 'shared-card', mapping)).rejects.toThrow('武器尚未建立共享映射');
    for (const weaponIds of [['same', 'same'], ['global/weapon'], Array.from({ length: 65 }, (_, i) => `weapon-${i}`)]) {
      await expect(serializeSharedDramaAsset({ ...source, weaponIds }, 'shared-card', {
        ...mapping, mapWeaponId: (value) => value,
      })).rejects.toThrow();
    }
    const payload = await serializeSharedDramaAsset(source, 'shared-card', { ...mapping, mapWeaponId: () => 'shared-sword' });
    expect(() => restoreSharedDramaAsset(payload, 'other-card', { memberId: (_kind, value) => value,
      mediaById: new Map(media.map((entry) => [entry.id, { assetId: `other-${entry.id}`,
        relativePath: `Library/${entry.id}.${entry.extension}`, url: `asset://localhost/Library/${entry.id}.${entry.extension}` }]))
    })).toThrow('武器尚未建立共享映射');
    const invalid = structuredClone(payload);
    if (invalid.data.kind === 'character') invalid.data.weaponIds = ['shared-card'];
    expect(() => parseSharedAssetSyncRevision(revision(invalid))).toThrow();
  });

  it('武器保留道具协议并校验固定子分类，普通道具维持兼容', async () => {
    const weapon: DramaProp = { id: 'weapon', kind: 'prop', propType: 'weapon', name: '长剑', key: '长剑',
      summary: '', visualNotes: '', importance: 'supporting', source: 'manual', confirmed: true, createdAt: 1, updatedAt: 2 };
    const payload = await serializeSharedDramaAsset(weapon, 'shared-card', mapping);
    expect(parseSharedAssetSyncRevision(revision(payload, [])).payload).toMatchObject({ kind: 'prop', data: { propType: 'weapon' } });
    const restored = restoreSharedDramaAsset(payload, 'other-weapon', {
      memberId: (_kind, value) => value, mediaById: new Map(),
    }) as DramaProp;
    expect(restored.propType).toBe('weapon');
    const invalid = structuredClone(payload);
    Object.assign(invalid.data, { propType: 'unknown' });
    expect(() => parseSharedAssetSyncRevision(revision(invalid, []))).toThrow();
    const ordinary = await serializeSharedDramaAsset({ ...weapon, propType: undefined }, 'shared-card', mapping);
    expect(parseSharedAssetSyncRevision(revision(ordinary, [])).payload).toEqual(ordinary);
  });

  it('图声动作闭包保留稳定共享ID、头像和主音色指针，剥离本机运行身份', async () => {
    const source = character();
    Object.assign(source, { libraryOrder: 4, filePath: 'C:/private/image.png',
      volcengineBinding: { projectName: 'private' }, refmods: [{ fileName: 'private.safetensors' }] });
    const before = JSON.stringify(source);
    const payload = await serializeSharedDramaAsset(source, 'shared-card', mapping);
    const result = parseSharedAssetSyncRevision(revision(payload));
    expect(result.payload.kind).toBe('character');
    expect(payload.data).toMatchObject({ id: 'shared-card', primaryReferenceImageId: 'referenceImage-ref',
      avatarReferenceImageId: 'referenceImage-ref', primaryVoiceClipId: 'voiceClip-voice' });
    expect(getSharedAssetSyncMediaIds(payload)).toEqual(['image', 'audio', 'video']);
    expect(await serializeSharedDramaAsset(source, 'shared-card', mapping)).toEqual(payload);
    expect(JSON.stringify(payload)).not.toMatch(/filePath|assetId|sourceNodeId|imageNodeId|libraryOrder|volcengineBinding|refmods|C:\//);
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each(['asset://localhost/', 'http://asset.localhost/', 'https://asset.localhost/', 'file:///'])(
    '双端映射接受本地地址 %s，保留卡片和子项ID且清理画布来源节点', async (prefix) => {
    const payload = await serializeSharedDramaAsset(character(), 'shared-card', mapping);
    const memberIds = new Map([['referenceImage-ref', 'ref'], ['voiceClip-voice', 'voice'],
      ['action-action', 'action'], ['actionMedia-action-image', 'action-image'], ['actionMedia-action-video', 'action-video']]);
    const restored = restoreSharedDramaAsset(payload, 'local-existing', {
      memberId: (_kind, sharedId) => memberIds.get(sharedId)!,
      mediaById: new Map(media.map((entry) => [entry.id, { assetId: `new-${entry.id}`, relativePath: `Library/${entry.id}.${entry.extension}`,
        url: `${prefix}project/Library/${entry.id}.${entry.extension}` }])),
    }) as DramaCharacter;
    expect(restored).toMatchObject({ id: 'local-existing', primaryReferenceImageId: 'ref', avatarReferenceImageId: 'ref',
      primaryVoiceClipId: 'voice', assetId: 'new-image' });
    expect(restored.referenceImages![0].id).toBe('ref');
    expect(restored.actions![0].id).toBe('action');
    expect(restored.actions![0].media![1].id).toBe('action-video');
    expect(restored.imageUrl).toBe(`${prefix}project/Library/image.png`);
    expect(restored.referenceImages![0].imageUrl).toBe(restored.imageUrl);
    expect(restored.voiceClips![0].audioUrl).toBe(`${prefix}project/Library/audio.wav`);
    expect(restored.actions![0].media![0].url).toBe(restored.imageUrl);
    expect(restored.actions![0].media![1].url).toBe(`${prefix}project/Library/video.mp4`);
    expect(restored.imageNodeId).toBeUndefined(); expect(restored.referenceImages![0].sourceNodeId).toBeUndefined();
  });

  it.each(['scene', 'prop'] as const)('场景与道具 %s 接受 Windows 编码的本地素材地址', async (kind) => {
    const source: DramaScene | DramaProp = { id: 'local-card', kind, name: '素材', key: '素材', summary: '', visualNotes: '',
      importance: 'supporting', source: 'manual', confirmed: true, createdAt: 1, updatedAt: 2,
      imageUrl: 'asset://localhost/project/image.png', assetId: 'local-image', primaryReferenceImageId: 'ref',
      referenceImages: [{ id: 'ref', label: '主图', prompt: '', assetId: 'local-image',
        imageUrl: 'asset://localhost/project/image.png', createdAt: 1, updatedAt: 2 }] };
    const payload = await serializeSharedDramaAsset(source, 'shared-card', mapping);
    const url = `http://asset.localhost/${encodeURIComponent('C:\\项目素材\\.shared-sync\\files\\image.png')}`;
    const restored = restoreSharedDramaAsset(payload, 'other-card', { memberId: (_kind, value) => `other-${value}`,
      mediaById: new Map([['image', { assetId: 'other-image', relativePath: '.shared-sync/files/image.png', url }]]) });
    expect(restored).toMatchObject({ kind, id: 'other-card', assetId: 'other-image', imageUrl: url,
      referenceImages: [{ id: 'other-referenceImage-ref', assetId: 'other-image', imageUrl: url }] });
  });

  it('接收恢复仍拒绝网络地址、伪装的本地来源、内嵌媒体和缺失映射', async () => {
    const payload = await serializeSharedDramaAsset(character(), 'shared-card', mapping);
    for (const url of ['https://example.com/image.png', 'http://asset.localhost.example.com/image.png',
      'http://asset.localhost@example.com/image.png', 'asset://example.com/image.png',
      'data:image/png;base64,AAAA', 'blob:http://asset.localhost/image', '']) {
      expect(() => restoreSharedDramaAsset(payload, 'other-card', { memberId: (_kind, value) => value,
        mediaById: new Map(media.map((entry) => [entry.id, { assetId: `other-${entry.id}`,
          relativePath: `Library/${entry.id}.${entry.extension}`, url }])) })).toThrow('项目共享资产格式无效');
    }
    expect(() => restoreSharedDramaAsset(payload, 'other-card', { memberId: (_kind, value) => value,
      mediaById: new Map() })).toThrow('项目共享资产格式无效');
  });

  it('合法共享身份恢复为本机中文、点号及256字符身份，保留精确图片/声音/动作与武器映射', async () => {
    const source = character();
    source.weaponIds = ['武器.长剑'];
    source.summary = '人物 @drama{friend:同伴}，图片 @drama{friend#ref:参考图}，声音 @drama{friend#voice/voice:音色}，动作 @drama{friend#action/action/item:行走}';
    const outbound: Record<string, string> = { friend: 'shared-friend', 'friend#ref': 'shared-friend#shared-ref',
      'friend#voice/voice': 'shared-friend#voice/shared-voice', 'friend#action/action/item': 'shared-friend#action/shared-action/shared-item' };
    const payload = await serializeSharedDramaAsset(source, 'shared-card', { ...mapping,
      mapWeaponId: () => 'shared-sword', mapMentionId: (value) => outbound[value] });
    expect(parseSharedAssetSyncRevision(revision(payload)).payload).toEqual(payload);
    const localEntityId = `人物.${'甲'.repeat(253)}`;
    expect(localEntityId).toHaveLength(256);
    const inbound: Record<string, string> = { 'shared-friend': localEntityId,
      'shared-friend#shared-ref': buildDramaMentionId(localEntityId, '图片.同伴'),
      'shared-friend#voice/shared-voice': buildDramaVoiceMentionId(localEntityId, '声音.同伴'),
      'shared-friend#action/shared-action/shared-item': buildDramaActionMentionId(localEntityId, '动作.同伴', '素材.同伴') };
    const restored = restoreSharedDramaAsset(payload, localEntityId, {
      memberId: (kind, value) => `${kind}.本机.${value}`, mapMentionId: (value) => inbound[value],
      mapWeaponId: () => '武器.长剑',
      mediaById: new Map(media.map((entry) => [entry.id, { assetId: `本机.${entry.id}`,
        relativePath: `Library/${entry.id}.${entry.extension}`, url: `http://asset.localhost/Library/${entry.id}.${entry.extension}` }])),
    }) as DramaCharacter;
    expect(restored).toMatchObject({ id: localEntityId, weaponIds: ['武器.长剑'],
      primaryReferenceImageId: 'referenceImage.本机.referenceImage-ref', avatarReferenceImageId: 'referenceImage.本机.referenceImage-ref',
      primaryVoiceClipId: 'voiceClip.本机.voiceClip-voice', actions: [{ id: 'action.本机.action-action',
        media: [{ id: 'actionMedia.本机.actionMedia-action-image' }, { id: 'actionMedia.本机.actionMedia-action-video' }] }] });
    expect(restored.summary).toBe(source.summary.replace(/@drama\{([^:}]+):/g, (_token, value: string) => `@drama{${inbound[outbound[value]]}:`));
    expect(source.weaponIds).toEqual(['武器.长剑']);
    const invalidWire = structuredClone(revision(payload));
    invalidWire.sharedAssetId = localEntityId;
    if (invalidWire.payload.kind !== 'file') invalidWire.payload.data.id = localEntityId;
    expect(() => parseSharedAssetSyncRevision(invalidWire)).toThrow('项目共享资产格式无效');
  });

  it('图片专属文本先验证wire身份，再恢复本机身份，仍拒绝全局/损坏/超限引用', () => {
    const wire = '@drama{shared-card#shared-ref:人物}';
    expect(restoreSharedAssetSyncText(wire, () => '人物.本机#图片.本机')).toBe('@drama{人物.本机#图片.本机:人物}');
    for (const unsafe of ['@drama{人物.本机:人物}', '@drama{shared.card:人物}', `@drama{${'x'.repeat(129)}:人物}`,
      '@drama{global/card:人物}', '@drama{shared-card#voice/:人物}', '@drama{shared-card:缺少结束', '@{node:节点}', '含\0文本']) {
      expect(() => restoreSharedAssetSyncText(unsafe, () => 'safe-local')).toThrow();
    }
    for (const local of ['', 'x'.repeat(257), '本机\n身份', 'global/card', 'card#voice/', 'card:其他人物', 'card}:改写正文']) {
      expect(() => restoreSharedAssetSyncText(wire, () => local)).toThrow();
    }
    expect(() => restoreSharedAssetSyncText(wire, () => `card#${'图'.repeat(256)}`)).not.toThrow();
    expect(() => restoreSharedAssetSyncText('文'.repeat(64 * 1024), () => 'safe-local')).toThrow();
  });

  it('本机武器映射仍拒绝全局、过长和控制字符身份，不污染有效载荷', async () => {
    const payload = await serializeSharedDramaAsset({ ...character(), weaponIds: ['local-sword'] }, 'shared-card', {
      ...mapping, mapWeaponId: () => 'shared-sword',
    });
    const before = JSON.stringify(payload);
    const mediaById = new Map(media.map((entry) => [entry.id, { assetId: `local-${entry.id}`,
      relativePath: `Library/${entry.id}.${entry.extension}`, url: `asset://localhost/Library/${entry.id}.${entry.extension}` }]));
    for (const local of ['global/weapon', '剑'.repeat(257), 'weapon\0id']) {
      expect(() => restoreSharedDramaAsset(payload, 'local-card', { memberId: (_kind, value) => value,
        mapWeaponId: () => local, mediaById })).toThrow('项目共享资产格式无效');
    }
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('恢复媒体错误包含稳定原因和字段，不泄露本机路径、URL或正文', async () => {
    const payload = await serializeSharedDramaAsset(character(), 'shared-card', mapping);
    const mediaById = new Map(media.map((entry) => [entry.id, { assetId: `local-${entry.id}`,
      relativePath: `private/${entry.id}.${entry.extension}`, url: `asset://localhost/private/${entry.id}.${entry.extension}` }]));
    mediaById.delete('audio');
    let missing: unknown;
    try { restoreSharedDramaAsset(payload, 'local-card', { memberId: (_kind, value) => value, mediaById }); }
    catch (error) { missing = error; }
    expect(missing).toBeInstanceOf(Error);
    expect((missing as Error).cause).toEqual({ reason: 'missingLocalMedia', fieldPath: 'payload.data.voiceClips[0].audioUrl', stage: 'restoreMedia' });
    expect((missing as Error).message).toContain('missingLocalMedia');
    mediaById.set('audio', { assetId: 'local-audio', relativePath: 'private/audio.wav', url: 'asset://localhost/private/audio.wav' });
    mediaById.set('video', { assetId: 'local-video', relativePath: 'private/video.mp4', url: 'https://secret.invalid/private/video.mp4' });
    let invalid: unknown;
    try { restoreSharedDramaAsset(payload, 'local-card', { memberId: (_kind, value) => value, mediaById }); }
    catch (error) { invalid = error; }
    expect(invalid).toBeInstanceOf(Error);
    expect((invalid as Error).cause).toEqual({ reason: 'invalidLocalMediaUrl', fieldPath: 'payload.data.actions[0].media[1].url', stage: 'restoreMedia' });
    expect((invalid as Error).message).toContain('invalidLocalMediaUrl');
    expect(JSON.stringify({ missing: (missing as Error).message, invalid: (invalid as Error).message,
      missingCause: (missing as Error).cause, invalidCause: (invalid as Error).cause })).not.toMatch(/secret|private|https?:\/\/|主音色|向前走/);
  });

  it('真实引用按显式映射保留；未知、本机与全局引用不静默脱为标签', async () => {
    const source = character(); source.summary = '调用 @drama{friend#ref:朋友}';
    const payload = await serializeSharedDramaAsset(source, 'shared-card', { ...mapping,
      mapMentionId: (identity) => identity === 'friend#ref' ? 'shared-friend#shared-ref' : 'unknown' });
    expect(payload.data.summary).toBe('调用 @drama{shared-friend#shared-ref:朋友}');
    expect(parseSharedAssetSyncRevision(revision(payload)).payload).toEqual(payload);
    await expect(serializeSharedDramaAsset(source, 'shared-card', mapping)).rejects.toThrow('共享映射');
    for (const unsafe of ['@asset{C%3A%2Fprivate.png}', '@{node:节点}', '@drama{global/card:角色}', '@wf{workflow|名称|args}']) {
      source.summary = unsafe;
      await expect(serializeSharedDramaAsset(source, 'shared-card', mapping)).rejects.toThrow();
    }
  });

  it('人物参考图和动作提示词先将唯一项目节点转为库引用，再映射共享卡片与子项', async () => {
    const source = character();
    source.referenceImages![0].prompt = '参考 @{node-image:主图}，保持白色背景';
    source.actions![0].prompt = '由 @{node-image:主图} 向前走';
    const library: DramaAssetLibrary = { version: 2, characters: [source], scenes: [], props: [] };
    const nodes = [{ id: 'node-image', data: { type: 'source-image', imageUrl: source.imageUrl } }];
    const before = JSON.stringify(source);
    const payload = await serializeSharedDramaAsset(source, 'shared-card', { ...mapping,
      mapProjectNodeReferences: (value) => preferDramaLibraryReferences(value, nodes, library, []),
      mapMentionId: (value) => {
        if (value !== 'local-card#ref') throw new Error('未映射引用');
        return 'shared-card#referenceImage-ref';
      } });
    const result = payload.data as DramaCharacter;
    expect(result.referenceImages![0].prompt).toBe('参考 @drama{shared-card#referenceImage-ref:人物甲}，保持白色背景');
    expect(result.actions![0].prompt).toBe('由 @drama{shared-card#referenceImage-ref:人物甲} 向前走');
    expect(getSharedAssetSyncMediaIds(payload)).toEqual(['image', 'audio', 'video']);
    expect(parseSharedAssetSyncRevision(revision(payload)).payload).toEqual(payload);
    expect(JSON.stringify(source)).toBe(before);
    const inbound = revision(payload);
    (inbound.payload as typeof payload).data.referenceImages![0].prompt = '@{node-image:主图}';
    expect(() => parseSharedAssetSyncRevision(inbound)).toThrow('尚未纳入共享');
  });

  it('项目节点归属不唯一或无法映射时保留原胶囊并拒绝，不回退全局或丢掉引用', async () => {
    const source = character(); const other = character(); other.id = 'other-card'; other.name = '另一个角色';
    const library: DramaAssetLibrary = { version: 2, characters: [source], scenes: [], props: [] };
    const nodes = [{ id: 'node-image', data: { type: 'source-image', imageUrl: source.imageUrl } },
      { id: 'global-node', data: { type: 'source-image', imageUrl: 'asset://localhost/global/only.png' } }];
    const callbacks = { ...mapping,
      mapProjectNodeReferences: (value: string) => preferDramaLibraryReferences(value, nodes, library, []),
      mapMentionId: () => 'shared-card#referenceImage-ref' };
    source.referenceImages![0].prompt = '@{node-image:主图}'; library.characters.push(other);
    await expect(serializeSharedDramaAsset(source, 'shared-card', callbacks)).rejects.toThrow('尚未纳入共享');
    library.characters = [source];
    for (const value of ['@{unknown-node:未知节点}', '@{global-node:全局图片}', '@asset{C%3A%2Fprivate.png}',
      '@drama{global/card:全局角色}', '@wf{workflow|名称|args}', '@model{model|模型}', '@skill{skill|技能}']) {
      source.referenceImages![0].prompt = value;
      await expect(serializeSharedDramaAsset(source, 'shared-card', callbacks)).rejects.toThrow();
      expect(source.referenceImages![0].prompt).toBe(value);
    }
  });

  it('普通文件仅接收标签与明确保存的图片专属信息及参考附件闭包', () => {
    const payload: SharedSyncFilePayload = { kind: 'file', name: '人物.png', displayRelativePath: 'Library/人物.png',
      mediaId: 'image', tags: ['角色'], taggedBy: 'manual', imageMetadata: { prompt: '资产专属提示词',
        references: [{ id: 'reference', name: '参考原图', mediaId: 'reference-image' }] } };
    const files = [media[0], { ...media[0], id: 'reference-image', sha256: 'd'.repeat(64) }];
    expect(parseSharedAssetSyncRevision(revision(payload, files)).payload).toEqual(payload);
    expect(getSharedAssetSyncMediaIds(payload)).toEqual(['image', 'reference-image']);
    for (const field of ['path', 'history', 'model', 'provider', 'params']) {
      const invalid = revision({ ...payload, [field]: 'private' } as SharedSyncFilePayload, files);
      expect(() => parseSharedAssetSyncRevision(invalid)).toThrow();
    }
    expect(() => parseSharedAssetSyncRevision(revision(payload, [media[0]]))).toThrow();
    expect(() => parseSharedAssetSyncRevision(revision({ ...payload, displayRelativePath: '../escape.png' }, files))).toThrow();
  });

  it('快照严格校验全部层级白名单、媒体类型与主素材指针', async () => {
    const payload = await serializeSharedDramaAsset(character(), 'shared-card', mapping);
    for (const mutate of [
      (value: SharedSyncRevision) => Object.assign(value, { secret: 'private' }),
      (value: SharedSyncRevision) => { if (value.payload.kind !== 'file') value.payload.data.imageNodeId = 'local-node'; },
      (value: SharedSyncRevision) => { if (value.payload.kind !== 'file') value.payload.data.primaryReferenceImageId = 'missing'; },
      (value: SharedSyncRevision) => { value.media[0].kind = 'audio'; },
      (value: SharedSyncRevision) => { value.media[0].sha256 = 'chain-v1'; },
      (value: SharedSyncRevision) => { value.media[0].bytes = 0; },
      (value: SharedSyncRevision) => { value.media[0].extension = 'exe'; },
      (value: SharedSyncRevision) => { value.media[0].extension = 'html'; },
    ]) {
      const value = structuredClone(revision(payload)); mutate(value);
      expect(() => parseSharedAssetSyncRevision(value)).toThrow();
    }
  });

  it('同名同内容卡片仍保有独立共享身份，内容对象可复用', async () => {
    const left = await serializeSharedDramaAsset(character(), 'left', mapping);
    const right = await serializeSharedDramaAsset(character(), 'right', mapping);
    expect(left.data.name).toBe(right.data.name);
    expect(left.data.id).not.toBe(right.data.id);
    expect(getSharedAssetSyncMediaIds(left)).toEqual(getSharedAssetSyncMediaIds(right));
  });

  it('准备稿不接受伪造hash或bytes，正式版本不接受缺失hash或多余媒体', async () => {
    const payload = await serializeSharedDramaAsset(character(), 'shared-card', mapping);
    const value = revision(payload);
    const draft = { ...value, media: media.map(({ id, kind, extension }) => ({ id, kind, extension })) };
    expect(parseSharedAssetSyncDraft(draft)).toEqual(draft);
    expect(() => parseSharedAssetSyncDraft(value)).toThrow();
    expect(() => parseSharedAssetSyncRevision(draft)).toThrow();
    expect(() => parseSharedAssetSyncRevision({ ...value, media: [...media, { ...media[0], id: 'unbound' }] })).toThrow();
    expect(() => sharedSyncMediaToken('../path')).toThrow();
  });
});
