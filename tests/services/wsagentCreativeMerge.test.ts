import { describe, expect, it } from 'vitest';
import type { WsagentCreativeEntity } from '../../src/types/wsagentShared';
import { mergeCreativeAsset, type CreativeLink, type CreativeSnapshot } from '../../src/services/wsagentCreativeMerge';

const old: CreativeSnapshot = { name: '原名称', description: '原文字', image: null };
const link: CreativeLink = { remoteId: 'section_role', local: old, remote: old };
const remote: WsagentCreativeEntity = {
  id: 'section_role', kind: 'character', name: old.name, description: old.description, revision: 'one', imageId: null,
};

describe('paired creative asset reconciliation', () => {
  it('merges edits to different fields in both directions', () => {
    const local = { ...old, name: '林禾' };
    const peer = { ...remote, description: '雨后候车' };
    expect(mergeCreativeAsset(local, local, peer, { ...old, description: peer.description }, link)).toEqual({
      localText: { name: '林禾', description: '雨后候车' },
      remoteText: { name: '林禾', description: '雨后候车' },
      image: 'keep',
    });
  });

  it('keeps both versions when both sides changed the same field differently', () => {
    const local = { ...old, name: 'Canvas 修改' };
    const peer = { ...remote, name: 'WSAGENT 修改' };
    expect(mergeCreativeAsset(local, local, peer, { ...old, name: peer.name }, link)).toBeNull();
  });

  it('uses each replica baseline so display normalization does not loop back as an edit', () => {
    const local = { ...old, description: '本地格式' };
    const peer = { ...remote, description: '另一端格式' };
    const peerVersion = { ...old, description: peer.description };
    expect(mergeCreativeAsset(local, local, peer, peerVersion, { ...link, local, remote: peerVersion }))
      .toMatchObject({ localText: { description: local.description }, remoteText: { description: peer.description } });
  });

  it('pulls a newly selected WSAGENT reference and rejects competing primary images', () => {
    const peer = { ...remote, imageId: 'ws-media' };
    const peerVersion = { ...old, image: peer.imageId };
    expect(mergeCreativeAsset(old, old, peer, peerVersion, link)).toMatchObject({ image: 'pull' });
    expect(mergeCreativeAsset(old, { ...old, image: 'canvas-media' }, peer, peerVersion, link)).toBeNull();
    expect(mergeCreativeAsset(old, { ...old, image: 'canvas-media' }, peer, peerVersion, undefined, true))
      .toMatchObject({ image: 'keep' });
  });
});
