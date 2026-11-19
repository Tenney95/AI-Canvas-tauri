import type { BaseNodeData } from './index';
import type { DramaAssetKind } from './dramaAssets';

export const WSAGENT_SHARED_CAPABILITY = 'wsagent.sharedImages';
export const WSAGENT_MEDIA_CAPABILITY = 'wsagent.projectMedia';
export const WSAGENT_SHARED_PERMISSION = 'wsagent.shared-images';
export const WSAGENT_PLUGIN_ID = 'ai-canvas.wsagent';
export const WSAGENT_NODE_ID = 'shared-images';
export const WSAGENT_IMAGE_PORT = 'image';
export const WSAGENT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function isWsagentSharedImagesNode(data: BaseNodeData | null | undefined): boolean {
  return data?.type === 'plugin-node' && data.pluginId === WSAGENT_PLUGIN_ID && data.pluginNodeId === WSAGENT_NODE_ID;
}

export const WSAGENT_IMAGE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const;

export type WsagentImageMime = keyof typeof WSAGENT_IMAGE_EXTENSIONS;

export interface WsagentSharedImage {
  id: string;
  sha256: string;
  name: string;
  mime: WsagentImageMime;
  bytes: number;
  source: 'canvas' | 'wsagent';
  createdAt: number;
}

export interface WsagentSharedPage {
  assets: WsagentSharedImage[];
  nextOffset: number | null;
}

export interface WsagentSharedStatus {
  ownerId: string;
  peerProjectId: string | null;
  port: number;
  enabled: boolean;
}

export type WsagentProjectMediaKind = 'image' | 'video' | 'audio';
export type WsagentProjectMediaFilter = 'all' | WsagentProjectMediaKind;

export interface WsagentProjectMediaItem {
  id: string;
  name: string;
  kind: WsagentProjectMediaKind;
  mime: string;
  bytes: number;
  createdAt: number;
  generated: boolean;
}

export interface WsagentProjectMediaPage {
  assets: WsagentProjectMediaItem[];
  nextOffset: number | null;
}

export type WsagentProjectMediaSelections = Partial<Record<WsagentProjectMediaKind, {
  assetId: string;
  name: string;
}>>;

export interface WsagentProjectMediaTarget {
  nodeId: string;
  targetHandle: string | null;
}

export interface WsagentCreativeEntity {
  id: string;
  kind: DramaAssetKind;
  name: string;
  description: string;
  revision: string;
  imageId: string | null;
  imageDigest?: string;
}

export interface WsagentCreativeEdit {
  id: string;
  kind: DramaAssetKind;
  name: string;
  description: string;
  expectedRevision: string | null;
  image?: { type: 'shared'; id: string } | { type: 'clear' };
}

export type WsagentCreativeSyncState = 'idle' | 'syncing' | 'ready' | 'offline' | 'conflict';

export interface WsagentScriptMetadata {
  id: string;
  title: string;
  revision: string;
  contentDigest: string;
}

export interface WsagentScript extends WsagentScriptMetadata {
  content: string;
}

export type WsagentScriptSyncState = WsagentCreativeSyncState | 'ambiguous' | 'deferred';
