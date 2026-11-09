/** 只把原项目内经 SHA 核验的不可变媒体文件投影为本机展示地址，不取得写入或生成权限。 */
import { invoke } from '@tauri-apps/api/core';
import type { ProjectRecord } from '../types/project';
import { getAssetUrlFromPath, getProjectDataDir, joinPath, stripVerbatimPrefix } from './fs/core';
import { isNativeMediaContentPath } from './nativeMediaContentPath';
import { isTauriAssetUrl, localMediaUrlToPath } from '../utils/mediaUrl';

type DisplayProject = Pick<ProjectRecord, 'id' | 'storageRootRef' | 'storageBindings'>;
export interface NativeMediaDisplayFile { relativePath: string; sha256: string; bytes?: number }
export interface NativeMediaDisplay { filePath: string; url: string }
export type NativeMediaDisplayResolver = ((rootRef: string, file: NativeMediaDisplayFile) => Promise<NativeMediaDisplay>)
  & { directory: (rootRef: string) => Promise<string> };
const rootId = /^r2-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const isNativeMediaResultArtifact = (value: unknown): boolean => typeof value === 'string'
  && /^native-media-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?:-[1-9][0-9]{0,2})?$/.test(value);

export function nativeMediaContentDigest(path: unknown): string | undefined {
  if (typeof path !== 'string') return undefined;
  const digest = /(?:^media\/|^imports\/retained-)([a-f0-9]{64})/.exec(path)?.[1];
  return digest && isNativeMediaContentPath(path, digest) ? digest : undefined;
}
function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const path = stripVerbatimPrefix(value).replace(/\\/g, '/').replace(/\/+$/, '');
    return /^(?:[a-z]:\/|\/\/)/i.test(path) ? path.toLowerCase() : path;
  };
  return normalize(left) === normalize(right);
}

/** 缓存只存活于一次加载/交付；不同作品、根或下一次操作必须重新读取字节证据。 */
export function createNativeMediaDisplayResolver(project: DisplayProject): NativeMediaDisplayResolver {
  const roots = new Map<string, Promise<string>>(), files = new Map<string, Promise<NativeMediaDisplay>>();
  const root = (rootRef: string) => {
    if (!rootId.test(rootRef) || !project.storageBindings.some((binding) => binding.rootRef === rootRef)) throw new Error('原媒体展示根不属于该项目');
    let pending = roots.get(rootRef);
    if (!pending) {
      pending = (async () => {
        const directory = rootRef === project.storageRootRef ? await getProjectDataDir(project.id)
          : await invoke<string>('resolve_native_project_media_subroot', { projectId: project.id, rootRef, create: false });
        if (typeof directory !== 'string' || !directory) throw new Error('原媒体展示根不可用');
        return directory;
      })();
      roots.set(rootRef, pending);
    }
    return pending;
  };
  const resolve = (rootRef: string, file: NativeMediaDisplayFile): Promise<NativeMediaDisplay> => {
    if (!isNativeMediaContentPath(file.relativePath, file.sha256)
      || file.bytes !== undefined && (!Number.isSafeInteger(file.bytes) || file.bytes <= 0)) return Promise.reject(new Error('原媒体展示缺少受控内容身份'));
    const key = JSON.stringify([rootRef, file.relativePath, file.sha256, file.bytes]);
    let pending = files.get(key);
    if (!pending) {
      pending = (async () => {
        const directory = await root(rootRef);
        const rows = await invoke<Array<{ path: string; bytes: number; sha256: string }>>('inspect_project_archive_assets', {
          assetsDir: directory, selectedPaths: [file.relativePath],
        });
        if (rows.length !== 1 || rows[0].path !== file.relativePath || rows[0].sha256 !== file.sha256
          || !Number.isSafeInteger(rows[0].bytes) || rows[0].bytes <= 0 || file.bytes !== undefined && rows[0].bytes !== file.bytes) throw new Error('原媒体展示文件缺失或摘要已变化');
        const filePath = joinPath(directory, file.relativePath), url = await getAssetUrlFromPath(filePath);
        const decoded = localMediaUrlToPath(url);
        if (!isTauriAssetUrl(url) || !decoded || !samePath(decoded, filePath)) throw new Error('原媒体本机展示地址不可用');
        return { filePath, url };
      })();
      files.set(key, pending);
    }
    return pending;
  };
  return Object.assign(resolve, { directory: root });
}
