import type { WsagentCreativeEntity } from '../types/wsagentShared';
import { sha256BytesHex } from './mediaDataUrl';

const encoder = new TextEncoder();
const hash = (value: string) => sha256BytesHex(encoder.encode(value));

export interface CreativeSnapshot {
  name: string;
  description: string;
  image: string | null;
}

export interface CreativeLink {
  remoteId: string;
  local: CreativeSnapshot;
  remote: CreativeSnapshot;
}

export interface CreativeText {
  name: string;
  description: string;
}

export async function creativeSnapshot(text: CreativeText, image: string | null): Promise<CreativeSnapshot> {
  const [name, description] = await Promise.all([hash(text.name), hash(text.description)]);
  return { name, description, image };
}

export const canvasSectionId = async (ownerId: string, id: string) =>
  `section_canvas_${await hash(JSON.stringify([ownerId, id]))}`;

export const wsagentAssetId = async (ownerId: string, projectId: string, sectionId: string) =>
  `wsagent-${await hash(JSON.stringify([ownerId, projectId, sectionId]))}`;

/** Both values can change while the peer is offline. An ambiguous field keeps both saved copies. */
export function mergeCreativeAsset(local: CreativeText, localVersion: CreativeSnapshot,
  remote: WsagentCreativeEntity, remoteVersion: CreativeSnapshot, base?: CreativeLink, imagesMatch = false,
): { localText: CreativeText; remoteText: CreativeText; image: 'keep' | 'push' | 'pull' } | null {
  const localText = { name: local.name, description: local.description };
  const remoteText = { name: remote.name, description: remote.description };
  for (const field of ['name', 'description'] as const) {
    if (localVersion[field] === remoteVersion[field]) continue;
    const push = base && base.local[field] !== localVersion[field];
    const pull = base && base.remote[field] !== remoteVersion[field];
    if (!base || (push && pull)) return null;
    if (pull) localText[field] = remote[field];
    if (push) remoteText[field] = local[field];
  }

  const push = base ? base.local.image !== localVersion.image : localVersion.image !== null;
  const pull = base ? base.remote.image !== remoteVersion.image : remoteVersion.image !== null;
  if (push && pull) {
    if (!imagesMatch && (localVersion.image !== null || remoteVersion.image !== null)) return null;
    return { localText, remoteText, image: 'keep' };
  }
  return { localText, remoteText, image: pull ? 'pull' : push ? 'push' : 'keep' };
}
