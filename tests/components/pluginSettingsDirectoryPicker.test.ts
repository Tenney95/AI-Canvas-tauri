import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isIgnoredPluginMetadataEntry,
  routePluginDirectorySelection,
} from '../../src/components/settings/PluginSettings';
import {
  readLocalPluginPackage,
  selectNativePluginDirectory,
} from '../../src/services/fs/pluginPackageFiles';

const native = vi.hoisted(() => ({
  open: vi.fn(),
  stat: vi.fn(),
  readDir: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/plugin-fs')>(),
  stat: native.stat,
  readDir: native.readDir,
  readFile: native.readFile,
}));

vi.mock('@tauri-apps/plugin-dialog', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/plugin-dialog')>(),
  open: native.open,
}));

const ROOT = 'G:/plugins/frame-review';
const RESOURCE = 'assets/prompts/template.json';
const encode = (text: string) => new TextEncoder().encode(text);
const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    apiVersion: 1,
    id: 'com.example.frame-review',
    name: '逐帧拉片',
    version: '1.0.0',
    category: 'media',
    entry: 'main.js',
    permissions: ['node.read', 'node.write', 'ui.custom', 'plugin.resources.read'],
    ui: { entry: 'ui.js', integrity: 'a'.repeat(64), exports: { review: 'Review' } },
    contributes: {
      nodeTools: [{
        id: 'review',
        title: '拉片',
        icon: 'lucide:film',
        placements: ['node-toolbar'],
        nodeTypes: ['source-video'],
        inputFields: ['output'],
        output: { mode: 'update-current', fields: ['output'] },
        dialog: { title: '拉片', ui: 'review', fields: [] },
      }],
    },
    ...overrides,
  });
}

const resources = [{
  id: 'prompt', path: RESOURCE, bytes: 2,
  integrity: 'b'.repeat(64), mediaType: 'application/json',
}];

/** 未列入声明的路径一旦被 stat/readDir/readFile 访问就报 forbidden path。 */
function mountPackage(overrides: Record<string, unknown> = {}) {
  const files = new Map([
    [`${ROOT}/manifest.json`, encode(manifest(overrides))],
    [`${ROOT}/main.js`, encode('definePlugin({ tools: {} });')],
    [`${ROOT}/ui.js`, encode('export function Review() {}')],
    [`${ROOT}/${RESOURCE}`, encode('{}')],
  ]);
  native.stat.mockImplementation(async (rawPath: string) => {
    const path = normalize(rawPath);
    if (path === ROOT) return { isDirectory: true, isFile: false, size: 0 };
    const bytes = files.get(path);
    if (!bytes) throw new Error(`forbidden path: ${path}`);
    return { isDirectory: false, isFile: true, size: bytes.byteLength };
  });
  native.readDir.mockImplementation(async (rawPath: string) => {
    if (normalize(rawPath) !== ROOT) throw new Error(`forbidden path: ${rawPath}`);
    return [
      ...['.git', '.github', 'node_modules', 'docs', 'tests', 'assets'].map((name) => ({
        name, isDirectory: true, isFile: false,
      })),
      ...['manifest.json', 'main.js', 'ui.js'].map((name) => ({ name, isDirectory: false, isFile: true })),
    ];
  });
  native.readFile.mockImplementation(async (rawPath: string) => {
    const bytes = files.get(normalize(rawPath));
    if (!bytes) throw new Error(`forbidden path: ${rawPath}`);
    return bytes;
  });
  return files;
}

beforeEach(() => {
  for (const mock of Object.values(native)) mock.mockReset();
});

describe('插件目录选择入口', () => {
  it('桌面端使用原生目录选择器并把选中目录交给既有安装链', async () => {
    const openNativeDirectory = vi.fn().mockResolvedValue('G:\\plugins\\frame-review');
    const openBrowserDirectory = vi.fn();
    const installFromPaths = vi.fn().mockResolvedValue(undefined);

    await routePluginDirectorySelection({
      tauri: true,
      openNativeDirectory,
      openBrowserDirectory,
      installFromPaths,
    });

    expect(openNativeDirectory).toHaveBeenCalledOnce();
    expect(openBrowserDirectory).not.toHaveBeenCalled();
    expect(installFromPaths).toHaveBeenCalledWith(['G:\\plugins\\frame-review']);
  });

  it('取消原生目录选择时不启动安装', async () => {
    const installFromPaths = vi.fn().mockResolvedValue(undefined);

    await routePluginDirectorySelection({
      tauri: true,
      openNativeDirectory: vi.fn().mockResolvedValue(null),
      openBrowserDirectory: vi.fn(),
      installFromPaths,
    });

    expect(installFromPaths).not.toHaveBeenCalled();
  });

  it('浏览器模式保留 webkitdirectory 兜底且不加载原生选择器', async () => {
    const openNativeDirectory = vi.fn();
    const openBrowserDirectory = vi.fn();

    await routePluginDirectorySelection({
      tauri: false,
      openNativeDirectory,
      openBrowserDirectory,
      installFromPaths: vi.fn(),
    });

    expect(openBrowserDirectory).toHaveBeenCalledOnce();
    expect(openNativeDirectory).not.toHaveBeenCalled();
  });

  it('排除版本库元数据但保留插件源码和普通点目录', () => {
    expect(isIgnoredPluginMetadataEntry('.git')).toBe(true);
    expect(isIgnoredPluginMetadataEntry('.GIT')).toBe(true);
    expect(isIgnoredPluginMetadataEntry('.hg')).toBe(true);
    expect(isIgnoredPluginMetadataEntry('.svn')).toBe(true);
    expect(isIgnoredPluginMetadataEntry('.github')).toBe(false);
    expect(isIgnoredPluginMetadataEntry('ui.js')).toBe(false);
  });

  it('实际目录选择带递归读取选项，使声明的多级 UI 和资源目录获得读取授权', async () => {
    const files = mountPackage({
      ui: { entry: 'build/js/ui.js', integrity: 'a'.repeat(64), exports: { review: 'Review' } },
      resources,
    });
    files.set(`${ROOT}/build/js/ui.js`, encode('export function Review() {}'));
    let recursiveGrant = false;
    native.open.mockImplementation(async (options: { recursive?: boolean }) => {
      recursiveGrant = options.recursive === true;
      return ROOT;
    });
    const stat = native.stat.getMockImplementation()!;
    native.stat.mockImplementation(async (path: string) => {
      if (path.slice(ROOT.length + 1).includes('/') && !recursiveGrant) {
        throw new Error(`forbidden path: ${path}, not allowed for allow-stat`);
      }
      return stat(path);
    });
    const install = vi.fn(async (paths: string[]) => {
      const bundle = await readLocalPluginPackage(paths, true);
      expect(bundle?.uiSource).toBe('export function Review() {}');
      expect(bundle?.resourcePayloads).toEqual([{ id: 'prompt', bytes: [123, 125] }]);
    });

    await routePluginDirectorySelection({
      tauri: true,
      openNativeDirectory: selectNativePluginDirectory,
      openBrowserDirectory: vi.fn(),
      installFromPaths: install,
    });

    expect(native.open).toHaveBeenCalledWith({
      directory: true, multiple: false, recursive: true, title: '选择插件文件夹',
    });
    expect(install).toHaveBeenCalledWith([ROOT]);
    expect(native.readDir).toHaveBeenCalledExactlyOnceWith(ROOT);
  });
});

describe('本地插件只读取 Manifest 声明的文件', () => {
  it('仓库内含 .git、.github/workflows 和嵌套清单时仍只读取根清单、main.js、ui.js', async () => {
    const files = mountPackage();
    files.set(`${ROOT}/docs/example/manifest.json`, encode('{}'));

    const bundle = await readLocalPluginPackage(['G:\\plugins\\frame-review\\'], true);

    expect(bundle?.manifest.id).toBe('com.example.frame-review');
    expect(bundle?.source).toBe('definePlugin({ tools: {} });');
    expect(bundle?.resourcePayloads).toEqual([]);
    expect(native.readDir).toHaveBeenCalledExactlyOnceWith('G:\\plugins\\frame-review\\');
    expect(native.stat.mock.calls.map(([path]) => normalize(path))).toEqual([
      ROOT, `${ROOT}/manifest.json`, `${ROOT}/main.js`, `${ROOT}/ui.js`,
    ]);
    expect(native.readFile.mock.calls.flat()).toEqual([
      `${ROOT}/manifest.json`, `${ROOT}/main.js`, `${ROOT}/ui.js`,
    ]);
  });

  it('拖入无根清单的普通目录时静默忽略，不搜索其嵌套清单', async () => {
    mountPackage();
    native.readDir.mockResolvedValue([{ name: 'docs', isDirectory: true, isFile: false }]);
    expect(await readLocalPluginPackage([ROOT])).toBeNull();
    expect(native.stat).toHaveBeenCalledExactlyOnceWith(ROOT);
    expect(native.readFile).not.toHaveBeenCalled();
  });

  it('主动选择无根清单的目录时明确报错', async () => {
    mountPackage();
    native.readDir.mockResolvedValue([]);
    await expect(readLocalPluginPackage([ROOT], true)).rejects.toThrow('根目录缺少 manifest.json');
    expect(native.readFile).not.toHaveBeenCalled();
  });

  it('全窗口拖入普通媒体文件时不读取其内容', async () => {
    native.stat.mockResolvedValue({ isFile: true, isDirectory: false, size: 20 });
    expect(await readLocalPluginPackage(['G:/media/clip.mp4'])).toBeNull();
    expect(native.readDir).not.toHaveBeenCalled();
    expect(native.readFile).not.toHaveBeenCalled();
  });

  it('直接拖入 manifest.json 时只读取其声明文件', async () => {
    mountPackage();
    expect(await readLocalPluginPackage([`${ROOT}/manifest.json`])).not.toBeNull();
    expect(native.readDir).not.toHaveBeenCalled();
    expect(native.readFile).toHaveBeenCalledTimes(3);
  });

  it('多个插件目录在读取任何源码前拒绝', async () => {
    native.stat.mockResolvedValue({ isFile: false, isDirectory: true, size: 0 });
    native.readDir.mockResolvedValue([{ name: 'manifest.json', isFile: true, isDirectory: false }]);
    await expect(readLocalPluginPackage([ROOT, 'G:/plugins/other'])).rejects.toThrow('一次只选择一个');
    expect(native.readFile).not.toHaveBeenCalled();
  });

  it.each(['main.js', 'ui.js', RESOURCE])('缺少声明文件 %s 时拒绝，不回退扫描其他目录', async (path) => {
    const files = mountPackage({ resources });
    files.delete(`${ROOT}/${path}`);
    await expect(readLocalPluginPackage([ROOT])).rejects.toThrow(`无法读取插件文件 ${path}`);
    expect(native.readDir).toHaveBeenCalledExactlyOnceWith(ROOT);
    expect(native.readFile).not.toHaveBeenCalledWith(`${ROOT}/${path}`);
  });

  it('资源大小不符时在读取内容前拒绝', async () => {
    const files = mountPackage({ resources });
    files.set(`${ROOT}/${RESOURCE}`, encode('too large'));
    await expect(readLocalPluginPackage([ROOT])).rejects.toThrow('字节数不匹配');
    expect(native.readFile).not.toHaveBeenCalledWith(`${ROOT}/${RESOURCE}`);
  });

  it('资源在 stat 后发生大小变化时仍拒绝', async () => {
    mountPackage({ resources });
    const read = native.readFile.getMockImplementation()!;
    native.readFile.mockImplementation(async (path: string) => (
      path === `${ROOT}/${RESOURCE}` ? encode('changed') : read(path)
    ));
    await expect(readLocalPluginPackage([ROOT])).rejects.toThrow('字节数不匹配');
  });

  it.each([
    { ui: { entry: 'ui/../../outside.js', integrity: 'a'.repeat(64), exports: { review: 'Review' } } },
    { resources: [{ ...resources[0], path: '../outside.json' }] },
  ])('清单包含越界路径时只读清单即拒绝：%j', async (overrides) => {
    mountPackage(overrides);
    await expect(readLocalPluginPackage([ROOT])).rejects.toThrow(/路径/);
    expect(native.readFile).toHaveBeenCalledExactlyOnceWith(`${ROOT}/manifest.json`);
  });

  it('拒绝非 UTF-8 文本，不以替换字符静默修改源码', async () => {
    const files = mountPackage();
    files.set(`${ROOT}/main.js`, new Uint8Array([0xff, 0xfe]));
    await expect(readLocalPluginPackage([ROOT])).rejects.toThrow('必须使用 UTF-8 编码');
    expect(native.readFile).not.toHaveBeenCalledWith(`${ROOT}/ui.js`);
  });

  it.each([
    ['manifest.json', 64 * 1024], ['main.js', 512 * 1024], ['ui.js', 2 * 1024 * 1024],
  ] as const)('超限 %s 在读取内容前拒绝', async (path, maxBytes) => {
    const files = mountPackage();
    files.set(`${ROOT}/${path}`, new Uint8Array(maxBytes + 1));
    await expect(readLocalPluginPackage([ROOT])).rejects.toThrow('过大');
    expect(native.readFile).not.toHaveBeenCalledWith(`${ROOT}/${path}`);
  });
});
