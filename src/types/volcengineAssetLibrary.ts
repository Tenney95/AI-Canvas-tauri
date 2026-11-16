/**
 * volcengineAssetLibrary — 定义方舟素材分组、素材与缓存的领域类型。
 */
export type VolcengineAssetStatus = 'Creating' | 'Active' | 'Failed' | 'Deleting' | string;

/** url 在界面中可为本地来源；提交 CreateAsset 前统一转换为 TOS 限时读取链接。 */
export interface VolcengineAssetCreateInput {
  assetType: 'Image' | 'Video' | 'Audio';
  groupId: string;
  name: string;
  url: string;
}

export interface VolcengineAssetGroup {
  id: string;
  name: string;
  description?: string;
  status?: VolcengineAssetStatus;
  createdAt?: string;
  updatedAt?: string;
}

export interface VolcengineAsset {
  id: string;
  groupId?: string;
  name: string;
  description?: string;
  status: VolcengineAssetStatus;
  assetType?: string;
  mimeType?: string;
  thumbnailUrl?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface VolcengineAssetLibraryConfig {
  enabled: boolean;
  defaultGroupId?: string;
  projectName?: string;
  region?: string;
  accessKeyIdRef?: string;
  secretAccessKeyRef?: string;
  /** 方舟控制台文档若调整资源路径，可在不改代码的情况下覆盖。 */
  apiBaseUrl?: string;
  autoSync?: boolean;
}

export interface VolcengineAssetLibrarySnapshot {
  groups: VolcengineAssetGroup[];
  assets: VolcengineAsset[];
  syncedAt?: number;
}
