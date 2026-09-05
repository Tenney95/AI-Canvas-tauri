import type { PluginPackageResourcePayload } from '../../types/plugin';
import { parsePluginBundle, parsePluginManifest } from '../plugins/pluginManifest';

type PluginFsReader = Pick<typeof import('@tauri-apps/plugin-fs'), 'readDir' | 'stat' | 'readFile'>;

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_UI_BYTES = 2 * 1024 * 1024;

export async function selectNativePluginDirectory(): Promise<string | string[] | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  return open({
    directory: true,
    multiple: false,
    // 声明的 UI / resources 可以在多级子目录内；仅授权用户主动选中的目录。
    recursive: true,
    title: '选择插件文件夹',
  });
}

async function readPackageFile(
  fs: PluginFsReader,
  prefix: string,
  relativePath: string,
  maxBytes: number,
  expectedBytes?: number,
): Promise<Uint8Array> {
  const path = `${prefix}${relativePath}`;
  let info;
  try {
    info = await fs.stat(path);
  } catch (cause) {
    throw new Error(`无法读取插件文件 ${relativePath}，请确认文件存在并重新选择插件根目录`, { cause });
  }
  if (!info.isFile) throw new Error(`插件文件 ${relativePath} 不是普通文件`);
  const checkSize = (size: number) => {
    if (expectedBytes !== undefined && size !== expectedBytes) {
      throw new Error(`插件包资源 ${relativePath} 字节数不匹配`);
    }
    if (size > maxBytes) throw new Error(`插件文件 ${relativePath} 过大`);
  };
  checkSize(info.size);
  const bytes = await fs.readFile(path);
  checkSize(bytes.byteLength);
  return bytes;
}

async function readPackageText(
  fs: PluginFsReader,
  prefix: string,
  relativePath: string,
  maxBytes: number,
): Promise<string> {
  const bytes = await readPackageFile(fs, prefix, relativePath, maxBytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`插件文件 ${relativePath} 必须使用 UTF-8 编码`, { cause });
  }
}

/** 只在用户提供的目录根部查清单，不递归查找开发仓库中的其他插件/文件。 */
export async function readLocalPluginPackage(paths: string[], requireManifest = false) {
  const fs = await import('@tauri-apps/plugin-fs');
  const manifests = new Set<string>();
  for (const rawPath of paths) {
    const path = rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const info = await fs.stat(rawPath);
    if (info.isDirectory) {
      // readDir 仅列举直接子项；不 stat 或进入 .git/.github/node_modules 等无关目录。
      const entries = await fs.readDir(rawPath);
      if (entries.some((entry) => entry.name === 'manifest.json')) {
        manifests.add(`${path}/manifest.json`);
      }
    } else if (path.endsWith('/manifest.json')) {
      manifests.add(path);
    }
  }

  if (manifests.size === 0) {
    // 原生拖放是全窗口事件，拖入画布的普通素材不应弹出插件安装错误。
    if (!requireManifest) return null;
    throw new Error('所选文件夹根目录缺少 manifest.json，请选择插件根目录');
  }
  if (manifests.size !== 1) throw new Error('请一次只选择一个插件根目录');

  const manifestPath = Array.from(manifests)[0];
  const prefix = manifestPath.slice(0, -'manifest.json'.length);
  const manifestText = await readPackageText(fs, prefix, 'manifest.json', MAX_MANIFEST_BYTES);
  // 必须先校验清单里的相对路径，再据此读取文件，禁止回退到全目录扫描。
  const declaredManifest = parsePluginManifest(manifestText);
  const source = await readPackageText(fs, prefix, declaredManifest.entry, MAX_SOURCE_BYTES);
  const manifest = parsePluginBundle(manifestText, source);
  const uiSource = manifest.ui
    ? await readPackageText(fs, prefix, manifest.ui.entry, MAX_UI_BYTES)
    : undefined;
  const resourcePayloads: PluginPackageResourcePayload[] = [];
  for (const resource of manifest.resources ?? []) {
    const bytes = await readPackageFile(fs, prefix, resource.path, resource.bytes, resource.bytes);
    resourcePayloads.push({ id: resource.id, bytes: Array.from(bytes) });
  }

  return { manifestText, manifest, source, uiSource, resourcePayloads };
}
