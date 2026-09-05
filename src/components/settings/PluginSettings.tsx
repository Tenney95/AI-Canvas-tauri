import { Icon } from '@iconify/react';
import { motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import pluginDeveloperGuide from '../../../doc/插件开发规范.md?raw';
import { isTauriEnv, saveBinaryToLocalFile } from '../../services/fileService';
import { readLocalPluginPackage, selectNativePluginDirectory } from '../../services/fs/pluginPackageFiles';
import { confirmAction } from '../../services/confirmDialog';
import {
  comparePluginVersions,
  loadPluginMarketplace,
  resolveGithubPlugin,
} from '../../services/plugins/pluginMarketplace';
import type { PluginMarketplaceItem } from '../../services/plugins/pluginMarketplace';
import { parsePluginManifest } from '../../services/plugins/pluginManifest';
import { getPythonPluginRuntimeStatus } from '../../services/plugins/pluginRuntime';
import { useAppStore } from '../../store/useAppStore';
import { getNodeTypeConfig } from '../../types';
import type {
  PluginCategory,
  PluginManifest,
  PluginPackageResourcePayload,
  PythonPluginRuntimeStatus,
} from '../../types/plugin';
import ChatMarkdown from '../chat/ChatMarkdown';
import AnimatedButton from '../shared/AnimatedButton';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';

const CATEGORY_LABELS: Record<PluginCategory, string> = {
  content: '内容处理',
  media: '媒体处理',
  workflow: '工作流',
  utility: '通用工具',
};

function isUpdateAvailable(latest: string, current: string): boolean {
  try {
    return comparePluginVersions(latest, current) > 0;
  } catch {
    return latest !== current;
  }
}

const EXAMPLE_MANIFEST = JSON.stringify({
  apiVersion: 1,
  id: 'com.ai-canvas.example-uppercase',
  name: '文本大写示例',
  version: '1.0.0',
  author: 'AI Canvas',
  description: '演示如何读取文本节点输出并写回结构化结果',
  category: 'content',
  keywords: ['文本', '示例'],
  entry: 'main.js',
  permissions: ['node.read', 'node.write', 'models.read', 'models.invoke'],
  contributes: {
    nodeTools: [{
      id: 'uppercase-output',
      title: '输出转大写',
      description: '把当前节点的 output 转为大写',
      placements: ['node-context-menu', 'node-toolbar'],
      icon: 'lucide:case-upper',
      dialog: {
        title: '输出转大写',
        description: '可选填写前缀；确认后插件会处理当前节点输出。',
        submitLabel: '转换',
        fields: [{
          id: 'prefix',
          label: '结果前缀',
          type: 'text',
          placeholder: '例如：标题：',
        }],
      },
      nodeTypes: ['ai-text', 'source-text'],
      inputFields: ['output'],
      output: { mode: 'update-current', fields: ['output'] },
    }],
    nodes: [{
      id: 'prompt-writer',
      title: '提示词写作节点',
      description: '选择已配置模型生成文本，可连接其他文本节点作为上下文。',
      icon: 'lucide:sparkles',
      inputs: [{ id: 'context', label: '上下文', type: 'text', multiple: true }],
      outputs: [{ id: 'result', label: '文本结果', type: 'text' }],
      fields: [
        { id: 'prompt', label: '提示词', type: 'textarea', required: true },
        { id: 'model', label: '模型', type: 'model', modelCategories: ['text'], required: true },
      ],
    }],
  },
}, null, 2);

const EXAMPLE_SOURCE = `definePlugin({
  tools: {
    "uppercase-output": (input) => ({
      data: {
        output: String(input.parameters.prefix || "") + String(input.node.data.output || "").toUpperCase()
      },
      message: "已将节点输出转换为大写"
    }),
    "prompt-writer": (input) => {
      if (!input.effectResult) {
        return {
          effect: {
            type: "model.generate",
            modelId: String(input.node.values.model || ""),
            prompt: [String(input.node.values.prompt || ""), ...(input.inputs.context || [])].join("\\n")
          }
        };
      }
      if (!input.effectResult.ok) throw new Error(input.effectResult.error || "模型调用失败");
      return {
        data: { outputs: { result: String(input.effectResult.value.text || "") } },
        message: "文本生成完成"
      };
    }
  }
});`;

const PYTHON_EXAMPLE_MANIFEST = JSON.stringify({
  apiVersion: 1,
  runtime: 'python',
  id: 'com.ai-canvas.example-python-uppercase',
  name: 'Python 文本大写示例',
  version: '1.0.0',
  author: 'AI Canvas',
  description: '演示可信 Python 插件读取文本节点并返回结构化结果',
  category: 'content',
  keywords: ['Python', '文本', '示例'],
  entry: 'main.py',
  permissions: ['node.read', 'node.write'],
  contributes: {
    nodeTools: [{
      id: 'python-uppercase-output',
      title: 'Python 输出转大写',
      placements: ['node-context-menu'],
      nodeTypes: ['ai-text', 'source-text'],
      inputFields: ['output'],
      output: { mode: 'update-current', fields: ['output'] },
    }],
  },
}, null, 2);

const PYTHON_EXAMPLE_SOURCE = `def uppercase_output(input_value):
    output = str(input_value["node"]["data"].get("output", ""))
    return {
        "data": {"output": output.upper()},
        "message": "已使用本机 Python 转换输出",
    }

define_plugin({"tools": {"python-uppercase-output": uppercase_output}})
`;

const PLUGIN_GUIDE_FILE_NAME = 'AI-Canvas-插件开发规范.md';
const MAX_DROPPED_PLUGIN_FILES = 256;
const IGNORED_PLUGIN_METADATA_ENTRIES = new Set(['.git', '.hg', '.svn']);

interface PluginUploadFile {
  file: File;
  path: string;
}

type PluginDirectoryPickerResult = string | string[] | null;

// 插件安装只消费 Manifest 声明的产物，版本库内部文件不属于插件包。
// eslint-disable-next-line react-refresh/only-export-components
export function isIgnoredPluginMetadataEntry(name: string): boolean {
  return IGNORED_PLUGIN_METADATA_ENTRIES.has(name.trim().toLocaleLowerCase());
}

// 独立导出用于验证桌面/浏览器分流；无组件状态或模块级副作用。
// eslint-disable-next-line react-refresh/only-export-components
export async function routePluginDirectorySelection({
  tauri,
  openNativeDirectory,
  openBrowserDirectory,
  installFromPaths,
}: {
  tauri: boolean;
  openNativeDirectory: () => Promise<PluginDirectoryPickerResult>;
  openBrowserDirectory: () => void;
  installFromPaths: (paths: string[]) => Promise<void>;
}): Promise<void> {
  if (!tauri) {
    openBrowserDirectory();
    return;
  }

  const selected = await openNativeDirectory();
  const directory = Array.isArray(selected) ? selected[0] : selected;
  if (typeof directory === 'string' && directory.trim()) {
    await installFromPaths([directory]);
  }
}

const PLUGIN_PERMISSION_LABELS: Record<string, string> = {
  'node.read': '读取声明的画布节点字段',
  'node.write': '修改节点或创建插件节点',
  'models.read': '读取脱敏模型目录',
  'models.invoke': '调用可能产生费用的模型',
  'files.connected.read': '读取当前节点及直接输入连线的项目资源',
  'files.output.create': '在当前项目目录创建新的文本输出',
  'plugin.resources.read': '读取当前插件 revision 声明的包资源',
  'ui.custom': '在主窗口隔离弹窗中运行自定义界面代码（可能影响界面响应）',
};

function permissionSummary(manifest: PluginManifest): string {
  return manifest.permissions
    .map((permission) => PLUGIN_PERMISSION_LABELS[permission] ?? permission)
    .join('；');
}

function pluginOperationErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return fallback;
}

async function computeSourceDigest(source: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function reviewPluginInstall(
  manifest: PluginManifest,
  source: string,
  action: '安装' | '更新',
  sourceLabel: string,
): Promise<string | null> {
  const sourceDigest = await computeSourceDigest(source);
  if (manifest.runtime !== 'python') return sourceDigest;
  const confirmed = await confirmAction(
    `${action}可信 Python 插件「${manifest.name}」？\n\n`
    + `来源：${sourceLabel}\n`
    + `代码 SHA-256：${sourceDigest}\n`
    + `宿主代办权限：${permissionSummary(manifest) || '无'}\n\n`
    + 'Python 插件会以你的当前系统权限运行，可以读取或修改本机文件、访问网络和环境变量，也可以启动其他程序。'
    + '\n\n只对你信任并已审查源码的插件继续。下一步 Rust 原生确认必须显示相同的完整摘要。',
    { title: `${action}可信 Python 插件` },
  );
  return confirmed ? sourceDigest : null;
}

async function confirmTrustedPythonEnable(manifest: PluginManifest, sourceDigest?: string): Promise<boolean> {
  if (manifest.runtime !== 'python') return true;
  return confirmAction(
    `启用可信 Python 插件「${manifest.name}」？\n\n`
    + `已登记代码 SHA-256：${sourceDigest ?? '旧记录待原生迁移'}\n`
    + `宿主代办权限：${permissionSummary(manifest) || '无'}\n\n`
    + '启用后插件会以你的当前系统权限运行，可以读取或修改本机文件、访问网络和环境变量，也可以启动其他程序。'
    + '\n\n继续后还必须通过 Rust 原生确认，且完整摘要应与这里一致。',
    { title: '启用可信 Python 插件' },
  );
}

function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile;
}

function isDirectoryEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory;
}

async function readDirectoryEntries(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: FileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) return entries;
    entries.push(...batch);
    if (entries.length > MAX_DROPPED_PLUGIN_FILES) throw new Error('插件文件夹包含的文件过多');
  }
}

async function collectDroppedEntry(
  entry: FileSystemEntry,
  parentPath: string,
  output: PluginUploadFile[],
): Promise<void> {
  if (isIgnoredPluginMetadataEntry(entry.name)) return;
  if (output.length >= MAX_DROPPED_PLUGIN_FILES) throw new Error('插件文件夹包含的文件过多');
  const path = `${parentPath}${entry.name}`;
  if (isFileEntry(entry)) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    output.push({ file, path });
    return;
  }
  if (!isDirectoryEntry(entry)) return;
  const entries = await readDirectoryEntries(entry);
  for (const child of entries) await collectDroppedEntry(child, `${path}/`, output);
}

async function droppedPluginFiles(dataTransfer: DataTransfer): Promise<PluginUploadFile[]> {
  const entries = Array.from(dataTransfer.items)
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => Boolean(entry));

  if (entries.length === 0) {
    return Array.from(dataTransfer.files).map((file) => ({ file, path: file.name }));
  }
  const files: PluginUploadFile[] = [];
  for (const entry of entries) await collectDroppedEntry(entry, '', files);
  return files;
}

/** 声明了 ui 的插件必须同时带上界面产物，否则 Rust 侧会以「缺少界面产物」拒绝暂存。 */
async function resolveUiSource(
  files: PluginUploadFile[],
  prefix: string,
  manifest: PluginManifest,
): Promise<string | undefined> {
  if (!manifest.ui) return undefined;
  const target = `${prefix}${manifest.ui.entry}`;
  const found = files.find(({ path }) => path === target);
  if (!found) throw new Error(`插件声明了自定义界面，但同级目录缺少 ${manifest.ui.entry}`);
  return found.file.text();
}

async function resolveResourcePayloads(
  files: PluginUploadFile[],
  prefix: string,
  manifest: PluginManifest,
): Promise<PluginPackageResourcePayload[]> {
  return Promise.all((manifest.resources ?? []).map(async (resource) => {
    const target = `${prefix}${resource.path}`;
    const found = files.find(({ path }) => path === target);
    if (!found) throw new Error(`插件包缺少资源 ${resource.path}`);
    if (found.file.size !== resource.bytes) throw new Error(`插件包资源 ${resource.path} 字节数不匹配`);
    return { id: resource.id, bytes: Array.from(new Uint8Array(await found.file.arrayBuffer())) };
  }));
}

export default function PluginSettings() {
  const inputRef = useRef<HTMLInputElement>(null);
  const plugins = useAppStore((state) => state.installedPlugins);
  const installPluginBundle = useAppStore((state) => state.installPluginBundle);
  const setPluginEnabled = useAppStore((state) => state.setPluginEnabled);
  const deletePlugin = useAppStore((state) => state.deletePlugin);
  const showToast = useAppStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [marketplaceItems, setMarketplaceItems] = useState<PluginMarketplaceItem[]>([]);
  const [marketplaceLoading, setMarketplaceLoading] = useState(true);
  const [marketplaceError, setMarketplaceError] = useState('');
  const [marketplaceQuery, setMarketplaceQuery] = useState('');
  const [repositoryInput, setRepositoryInput] = useState('');
  const [installingRepository, setInstallingRepository] = useState('');
  const [pythonStatus, setPythonStatus] = useState<PythonPluginRuntimeStatus | null>(null);
  const [pythonChecking, setPythonChecking] = useState(false);
  const installedRepositories = useMemo(
    () => plugins.flatMap((plugin) => plugin.manifest.repository ? [plugin.manifest.repository] : []),
    [plugins],
  );

  const refreshMarketplace = useCallback(async (force = false) => {
    setMarketplaceLoading(true);
    setMarketplaceError('');
    try {
      setMarketplaceItems(await loadPluginMarketplace(installedRepositories, { force }));
    } catch (error) {
      setMarketplaceError(error instanceof Error ? error.message : '插件市场加载失败');
    } finally {
      setMarketplaceLoading(false);
    }
  }, [installedRepositories]);

  const refreshPythonStatus = useCallback(async () => {
    if (!isTauriEnv()) {
      setPythonStatus({ available: false, error: '请在 Tauri 桌面版中检测本机 Python' });
      return;
    }
    setPythonChecking(true);
    try {
      setPythonStatus(await getPythonPluginRuntimeStatus());
    } catch (error) {
      setPythonStatus({
        available: false,
        error: error instanceof Error ? error.message : 'Python 环境检测失败',
      });
    } finally {
      setPythonChecking(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshMarketplace(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshMarketplace]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshPythonStatus(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshPythonStatus]);

  const visibleMarketplaceItems = useMemo(() => {
    const query = marketplaceQuery.trim().toLocaleLowerCase();
    if (!query) return marketplaceItems;
    return marketplaceItems.filter((item) => {
      if (item.status === 'error') return item.repository.toLocaleLowerCase().includes(query);
      return [
        item.manifest.name,
        item.manifest.description,
        item.manifest.author,
        item.repository,
        ...(item.manifest.keywords ?? []),
      ].some((value) => value?.toLocaleLowerCase().includes(query));
    });
  }, [marketplaceItems, marketplaceQuery]);

  const installGithubPlugin = async (repository: string, item?: PluginMarketplaceItem) => {
    if (!repository.trim() || installingRepository) return;
    setInstallingRepository(repository);
    try {
      const plugin = item?.status === 'ready'
        ? item
        : await resolveGithubPlugin(repository, { force: true });
      const action = plugins.some((installed) => installed.id === plugin.manifest.id) ? '更新' : '安装';
      const sourceDigest = await reviewPluginInstall(plugin.manifest, plugin.source, action, plugin.repository);
      if (!sourceDigest) return;
      await installPluginBundle(plugin.manifestText, plugin.source, {
        trustedPythonConfirmed: plugin.manifest.runtime === 'python',
        expectedSourceDigest: sourceDigest,
        uiSource: plugin.uiSource,
        resourcePayloads: plugin.resourcePayloads,
      });
      setRepositoryInput('');
      await refreshMarketplace(true);
    } catch (error) {
      showToast(pluginOperationErrorMessage(error, 'GitHub 插件安装失败'), 'error');
    } finally {
      setInstallingRepository('');
    }
  };

  const downloadDeveloperGuide = async () => {
    try {
      if (isTauriEnv()) {
        const savedPath = await saveBinaryToLocalFile(
          new TextEncoder().encode(pluginDeveloperGuide),
          PLUGIN_GUIDE_FILE_NAME,
          [{ name: 'Markdown 文档', extensions: ['md'] }],
        );
        if (savedPath) showToast('插件开发规范已保存');
        return;
      }

      const url = URL.createObjectURL(new Blob([pluginDeveloperGuide], { type: 'text/markdown;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = PLUGIN_GUIDE_FILE_NAME;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      showToast('插件开发规范已下载');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '插件开发规范下载失败', 'error');
    }
  };

  const installFiles = async (files: PluginUploadFile[]) => {
    if (files.length === 0) return;
    setBusy(true);
    try {
      const manifests = files.filter(({ file }) => file.name === 'manifest.json');
      if (manifests.length !== 1) throw new Error('插件文件夹必须且只能包含一个 manifest.json');
      const manifestFile = manifests[0];
      const manifestText = await manifestFile.file.text();
      const manifest = parsePluginManifest(manifestText);
      const prefix = manifestFile.path.slice(0, Math.max(0, manifestFile.path.length - manifestFile.file.name.length));
      const entryFile = files.find(({ path }) => path === `${prefix}${manifest.entry}`);
      if (!entryFile) throw new Error(`manifest.json 同级目录缺少 ${manifest.entry}`);
      const action = plugins.some((installed) => installed.id === manifest.id) ? '更新' : '安装';
      const source = await entryFile.file.text();
      const uiSource = await resolveUiSource(files, prefix, manifest);
      const resourcePayloads = await resolveResourcePayloads(files, prefix, manifest);
      const sourceDigest = await reviewPluginInstall(manifest, source, action, '本地文件夹');
      if (!sourceDigest) return;
      await installPluginBundle(manifestText, source, {
        trustedPythonConfirmed: manifest.runtime === 'python',
        expectedSourceDigest: sourceDigest,
        uiSource,
        resourcePayloads,
      });
    } catch (error) {
      showToast(pluginOperationErrorMessage(error, '插件安装失败'), 'error');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  // Tauri 原生目录选择/拖拽共用按 Manifest 读取的安装链。
  const installFromPaths = async (paths: string[], requireManifest = false) => {
    if (busy || paths.length === 0) return;
    setBusy(true);
    try {
      const bundle = await readLocalPluginPackage(paths, requireManifest);
      if (!bundle) return;
      const { manifestText, manifest, source, uiSource, resourcePayloads } = bundle;
      const action = plugins.some((installed) => installed.id === manifest.id) ? '更新' : '安装';
      const sourceDigest = await reviewPluginInstall(manifest, source, action, '本地文件夹');
      if (!sourceDigest) return;
      await installPluginBundle(manifestText, source, {
        trustedPythonConfirmed: manifest.runtime === 'python',
        expectedSourceDigest: sourceDigest,
        uiSource,
        resourcePayloads,
      });
    } catch (error) {
      showToast(pluginOperationErrorMessage(error, '插件安装失败'), 'error');
    } finally {
      setBusy(false);
    }
  };

  // 监听器只注册一次，但始终调用最新闭包（busy / plugins）
  const installFromPathsRef = useRef(installFromPaths);
  useEffect(() => {
    installFromPathsRef.current = installFromPaths;
  });

  useEffect(() => {
    if (!isTauriEnv()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      if (cancelled) return;
      unlisten = await listen<{ paths: string[] }>('tauri://drag-drop', (event) => {
        void installFromPathsRef.current(event.payload?.paths ?? []);
      });
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const openPluginDirectory = async () => {
    if (busy) return;
    try {
      await routePluginDirectorySelection({
        tauri: isTauriEnv(),
        openNativeDirectory: selectNativePluginDirectory,
        openBrowserDirectory: () => inputRef.current?.click(),
        installFromPaths: (paths) => installFromPathsRef.current(paths, true),
      });
    } catch (error) {
      showToast(pluginOperationErrorMessage(error, '无法选择插件文件夹'), 'error');
    }
  };

  const togglePlugin = async (plugin: (typeof plugins)[number]) => {
    const enabled = !plugin.enabled;
    if (enabled && !(await confirmTrustedPythonEnable(plugin.manifest, plugin.sourceDigest))) return;
    await setPluginEnabled(plugin.id, enabled, {
      trustedPythonConfirmed: enabled && plugin.manifest.runtime === 'python',
    });
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (busy) return;
    try {
      const files = await droppedPluginFiles(event.dataTransfer);
      // Tauri 原生拖拽下 DataTransfer 是空的，交给全局事件处理，避免误报和重复安装
      if (files.length === 0) return;
      await installFiles(files);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法读取插件文件夹', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-canvas-border bg-canvas-card p-3">
        <div>
          <div>
            <h3 className="text-sm font-medium text-canvas-text">用户插件</h3>
            <p className="mt-1 text-[11px] leading-5 text-canvas-text-muted">
              JavaScript 插件使用 QuickJS 沙箱；可信 Python 插件使用本机 Python 和已安装依赖，并拥有当前用户的本机权限。
            </p>
          </div>
          <motion.div
            className={`ui-dropzone mt-3${dragOver ? ' is-dragover' : ''}${busy ? ' pointer-events-none opacity-60' : ''}`}
            role="button"
            tabIndex={busy ? -1 : 0}
            aria-disabled={busy}
            aria-busy={busy}
            onClick={() => void openPluginDirectory()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                void openPluginDirectory();
              }
            }}
            onDragOver={(event) => {
              event.preventDefault();
              if (!busy) setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => void handleDrop(event)}
            whileTap={busy ? undefined : { scale: 0.995 }}
          >
            <span className="ui-dropzone__title">
              {busy ? '正在校验并安装插件…' : '把插件文件夹拖到这里'}
            </span>
            <span className="ui-dropzone__icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </span>
            <span className="ui-dropzone__hint">
              支持 manifest.json + main.js 或 main.py，点击这里也可以选择。
            </span>
          </motion.div>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            multiple
            {...({ webkitdirectory: '' } as Record<string, string>)}
            onChange={(event) => void installFiles(
              Array.from(event.currentTarget.files ?? []).map((file) => ({
                file,
                path: file.webkitRelativePath || file.name,
              })),
            )}
          />
        </div>
        <div className={`mt-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${pythonStatus?.available ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-amber-500/20 bg-amber-500/5'}`}>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-medium text-canvas-text">
              <Icon icon="lucide:terminal-square" width={14} height={14} className={pythonStatus?.available ? 'text-emerald-400' : 'text-amber-400'} />
              本机 Python
            </div>
            <div className="mt-0.5 break-words text-[11px] text-canvas-text-muted">
              {pythonChecking
                ? '正在检测 Python 3…'
                : pythonStatus?.available
                  ? `可用：${pythonStatus.command} · Python ${pythonStatus.version}`
                  : pythonStatus?.error || '尚未检测'}
            </div>
          </div>
          <AnimatedButton
            type="button"
            disabled={pythonChecking}
            className="shrink-0 rounded-md px-2.5 py-1.5 text-xs text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-50"
            onClick={() => void refreshPythonStatus()}
          >
            重新检测
          </AnimatedButton>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-canvas-border bg-canvas-surface px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-medium text-canvas-text">
              <Icon icon="lucide:book-open-text" width={14} height={14} className="text-indigo-400" />
              插件开发规范
            </div>
            <div className="mt-0.5 text-[11px] text-canvas-text-muted">
              查看 Manifest、节点输入输出、权限和沙箱规则
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <AnimatedButton
              type="button"
              className="rounded-md px-2.5 py-1.5 text-xs text-indigo-400 hover:bg-indigo-500/10"
              onClick={() => setGuideOpen(true)}
            >
              查看规范
            </AnimatedButton>
            <AnimatedButton
              type="button"
              scale={1.02}
              tapScale={0.97}
              aria-label="下载插件开发规范 Markdown"
              className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-canvas-border bg-canvas-card px-2.5 text-[11px] font-medium text-canvas-text-secondary transition-colors duration-150 hover:border-indigo-400/35 hover:bg-indigo-500/10 hover:text-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/45"
              onClick={() => void downloadDeveloperGuide()}
            >
              <Icon icon="lucide:download" width={14} height={14} className="shrink-0" />
              下载
            </AnimatedButton>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-canvas-border bg-canvas-surface px-3 py-2">
          <div className="min-w-0">
            <div className="text-xs font-medium text-canvas-text">开发者示例</div>
            <div className="mt-0.5 text-[11px] text-canvas-text-muted">安装文本工具和一个可调用模型的自定义写作节点</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <AnimatedButton
              type="button"
              className="rounded-md px-2.5 py-1.5 text-xs text-indigo-400 hover:bg-indigo-500/10"
              onClick={() => void installPluginBundle(EXAMPLE_MANIFEST, EXAMPLE_SOURCE).catch((error) => {
                showToast(pluginOperationErrorMessage(error, '示例插件安装失败'), 'error');
              })}
            >
              JavaScript
            </AnimatedButton>
            <AnimatedButton
              type="button"
              className="rounded-md px-2.5 py-1.5 text-xs text-amber-400 hover:bg-amber-500/10"
              onClick={() => void (async () => {
                const manifest = parsePluginManifest(PYTHON_EXAMPLE_MANIFEST);
                const sourceDigest = await reviewPluginInstall(
                  manifest,
                  PYTHON_EXAMPLE_SOURCE,
                  '安装',
                  '应用内置开发者示例',
                );
                if (!sourceDigest) return;
                await installPluginBundle(PYTHON_EXAMPLE_MANIFEST, PYTHON_EXAMPLE_SOURCE, {
                  trustedPythonConfirmed: true,
                  expectedSourceDigest: sourceDigest,
                });
              })().catch((error) => {
                showToast(pluginOperationErrorMessage(error, 'Python 示例安装失败'), 'error');
              })}
            >
              Python
            </AnimatedButton>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-canvas-border bg-canvas-card p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5 text-sm font-medium text-canvas-text">
              <Icon icon="lucide:store" width={16} height={16} className="text-indigo-400" />
              插件市场
            </div>
            <p className="mt-1 text-[11px] leading-5 text-canvas-text-muted">
              从已登记的 GitHub Release 安装插件，并检查已安装 GitHub 插件的新版本。
            </p>
          </div>
          <AnimatedButton
            type="button"
            aria-label="刷新插件市场"
            disabled={marketplaceLoading}
            className="rounded-md p-1.5 text-canvas-text-muted hover:bg-indigo-500/10 hover:text-indigo-400 disabled:opacity-50"
            onClick={() => void refreshMarketplace(true)}
          >
            <Icon icon="lucide:refresh-cw" width={14} height={14} className={marketplaceLoading ? 'animate-spin' : ''} />
          </AnimatedButton>
        </div>

        <div className="mt-3 flex gap-2">
          <input
            value={repositoryInput}
            onChange={(event) => setRepositoryInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void installGithubPlugin(repositoryInput);
            }}
            placeholder="GitHub 仓库地址，例如 owner/my-plugin"
            aria-label="GitHub 插件仓库地址"
            className="min-w-0 flex-1 rounded-lg border border-canvas-border bg-canvas-surface px-3 py-2 text-xs text-canvas-text outline-none placeholder:text-canvas-text-muted focus:border-indigo-400/50"
          />
          <AnimatedButton
            type="button"
            disabled={!repositoryInput.trim() || Boolean(installingRepository)}
            className="shrink-0 rounded-lg bg-indigo-500/15 px-3 text-xs font-medium text-indigo-400 hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void installGithubPlugin(repositoryInput)}
          >
            {installingRepository === repositoryInput ? '读取中…' : '从仓库安装'}
          </AnimatedButton>
        </div>

        {(marketplaceItems.length > 0 || marketplaceQuery) && (
          <div className="relative mt-3">
            <Icon icon="lucide:search" width={14} height={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-canvas-text-muted" />
            <input
              value={marketplaceQuery}
              onChange={(event) => setMarketplaceQuery(event.target.value)}
              placeholder="搜索插件、作者或关键词"
              aria-label="搜索插件市场"
              className="w-full rounded-lg border border-canvas-border bg-canvas-surface py-2 pl-8 pr-3 text-xs text-canvas-text outline-none placeholder:text-canvas-text-muted focus:border-indigo-400/50"
            />
          </div>
        )}

        <div className="mt-3 space-y-2">
          {marketplaceLoading && marketplaceItems.length === 0 && (
            <div className="rounded-lg border border-dashed border-canvas-border px-3 py-6 text-center text-xs text-canvas-text-muted">
              正在读取 GitHub 插件列表…
            </div>
          )}
          {marketplaceError && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-400">
              {marketplaceError}
            </div>
          )}
          {!marketplaceLoading && !marketplaceError && marketplaceItems.length === 0 && (
            <div className="rounded-lg border border-dashed border-canvas-border px-3 py-6 text-center text-xs text-canvas-text-muted">
              市场暂未收录插件，可先粘贴 GitHub 仓库地址安装。
            </div>
          )}
          {visibleMarketplaceItems.map((item) => {
            if (item.status === 'error') {
              return (
                <article key={item.repository} className="rounded-lg border border-canvas-border bg-canvas-surface p-3">
                  <div className="truncate text-xs font-medium text-canvas-text">{item.repository}</div>
                  <div className="mt-1 text-[11px] text-red-400">{item.error}</div>
                </article>
              );
            }
            const installed = plugins.find((plugin) => plugin.id === item.manifest.id);
            const updateAvailable = installed
              ? isUpdateAvailable(item.manifest.version, installed.manifest.version)
              : false;
            const actionDisabled = Boolean(installed && !updateAvailable) || Boolean(installingRepository);
            return (
              <article key={item.repository} className="rounded-lg border border-canvas-border bg-canvas-surface p-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400">
                    <Icon icon="lucide:blocks" width={18} height={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-canvas-text">{item.manifest.name}</span>
                      <span className="rounded bg-canvas-card px-1.5 py-0.5 text-[10px] text-canvas-text-muted">v{item.manifest.version}</span>
                      {item.featured && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">推荐</span>}
                      {item.manifest.runtime === 'python' && <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">可信本机代码</span>}
                      {updateAvailable && <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">可更新</span>}
                    </div>
                    <p className="mt-1 text-[11px] leading-4 text-canvas-text-secondary">
                      {item.manifest.description || '未提供说明'}
                    </p>
                    <a
                      href={item.repository}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 block truncate text-[10px] text-canvas-text-muted hover:text-indigo-400"
                    >
                      {item.repository.replace('https://github.com/', '')}
                    </a>
                    <div className="mt-1 text-[10px] text-canvas-text-muted">
                      {CATEGORY_LABELS[item.manifest.category]} · 权限：{item.manifest.permissions.join('、')}
                    </div>
                  </div>
                  <AnimatedButton
                    type="button"
                    disabled={actionDisabled}
                    className="shrink-0 rounded-md bg-indigo-500/10 px-2.5 py-1.5 text-[11px] font-medium text-indigo-400 hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:bg-canvas-card disabled:text-canvas-text-muted"
                    onClick={() => void installGithubPlugin(item.repository, item)}
                  >
                    {installingRepository === item.repository
                      ? '安装中…'
                      : updateAvailable
                        ? '更新'
                        : installed
                          ? '已安装'
                          : '安装'}
                  </AnimatedButton>
                </div>
              </article>
            );
          })}
          {!marketplaceLoading && marketplaceItems.length > 0 && visibleMarketplaceItems.length === 0 && (
            <div className="py-4 text-center text-xs text-canvas-text-muted">没有匹配的插件</div>
          )}
        </div>
      </section>

      <section className="space-y-2">
        {plugins.map((plugin) => {
          const nodeTypes = [...new Set(plugin.manifest.contributes.nodeTools.flatMap((tool) => tool.nodeTypes))];
          const customNodes = plugin.manifest.contributes.nodes ?? [];
          const inputFields = [...new Set(plugin.manifest.contributes.nodeTools.flatMap((tool) => tool.inputFields))];
          const outputFields = [...new Set(plugin.manifest.contributes.nodeTools.flatMap((tool) => tool.output.fields))];
          const placements = new Set(plugin.manifest.contributes.nodeTools.flatMap((tool) => tool.placements));
          const placementLabels = [
            placements.has('node-context-menu') ? '节点右键菜单' : null,
            placements.has('node-toolbar') ? '节点工具栏' : null,
          ].filter(Boolean).join('、');
          return (
            <article key={plugin.id} className="rounded-xl border border-canvas-border bg-canvas-card p-3">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400">
                  <Icon icon="lucide:blocks" width={18} height={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="truncate text-sm font-medium text-canvas-text">{plugin.manifest.name}</h4>
                    <span className="rounded bg-canvas-surface px-1.5 py-0.5 text-[10px] text-canvas-text-muted">v{plugin.manifest.version}</span>
                    <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] text-indigo-400">
                      {CATEGORY_LABELS[plugin.manifest.category]}
                    </span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${plugin.manifest.runtime === 'python' ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                      {plugin.manifest.runtime === 'python' ? 'Python · 可信本机代码' : 'JavaScript · 沙箱'}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-4 text-canvas-text-secondary">
                    {plugin.manifest.description || '未提供说明'}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {nodeTypes.map((nodeType) => (
                      <span key={nodeType} className="rounded bg-canvas-surface px-1.5 py-0.5 text-[10px] text-canvas-text-muted">
                        {getNodeTypeConfig(nodeType).label}
                      </span>
                    ))}
                    {customNodes.map((node) => (
                      <span key={node.id} className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] text-indigo-400">
                        {node.title}
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 text-[10px] leading-4 text-canvas-text-muted">
                    API v{plugin.manifest.apiVersion} · {plugin.manifest.entry} · 入口：{placementLabels || (customNodes.length ? '节点选择器' : '未声明')}<br />
                    工具 {plugin.manifest.contributes.nodeTools.length} 个 · 自定义节点 {customNodes.length} 个<br />
                    读取：{inputFields.join('、') || '无'} · 写入：{outputFields.join('、') || '无'}<br />
                    权限：{plugin.manifest.permissions.join('、')}<br />
                    代码 SHA-256：<span className="break-all font-mono" title={plugin.sourceDigest}>{plugin.sourceDigest ?? '待原生迁移'}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <AnimatedButton
                    type="button"
                    role="switch"
                    aria-checked={plugin.enabled}
                    className={`rounded-md px-2 py-1 text-[11px] ${plugin.enabled ? 'bg-emerald-500/10 text-emerald-400' : 'bg-canvas-surface text-canvas-text-muted'}`}
                    onClick={() => void togglePlugin(plugin).catch((error) => {
                      showToast(error instanceof Error ? error.message : '插件状态保存失败', 'error');
                    })}
                  >
                    {plugin.enabled ? '已启用' : '已停用'}
                  </AnimatedButton>
                  <AnimatedButton
                    type="button"
                    aria-label={`卸载 ${plugin.manifest.name}`}
                    className="rounded-md p-1.5 text-canvas-text-muted hover:bg-red-500/10 hover:text-red-400"
                    onClick={() => {
                      void confirmAction(`确定卸载插件「${plugin.manifest.name}」吗？`, { title: '卸载插件' }).then((confirmed) => {
                        if (!confirmed) return;
                        void deletePlugin(plugin.id).catch((error) => {
                          showToast(error instanceof Error ? error.message : '插件卸载失败', 'error');
                        });
                      });
                    }}
                  >
                    <Icon icon="lucide:trash-2" width={14} height={14} />
                  </AnimatedButton>
                </div>
              </div>
            </article>
          );
        })}
        {plugins.length === 0 && (
          <div className="rounded-xl border border-dashed border-canvas-border p-8 text-center text-xs text-canvas-text-muted">
            还没有安装插件
          </div>
        )}
      </section>

      <ModalOverlay
        isOpen={guideOpen}
        onClose={() => setGuideOpen(false)}
        ariaLabel="AI Canvas 插件开发规范"
        className="h-[min(780px,calc(100vh-40px))] w-[min(920px,calc(100vw-40px))] border-canvas-border"
        motionPreset="quick"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-canvas-border px-4 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400">
            <Icon icon="lucide:book-open-text" width={18} height={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-canvas-text">AI Canvas 插件开发规范</h2>
            <p className="mt-0.5 text-[11px] text-canvas-text-muted">Plugin API v1 · 与当前插件运行时同步</p>
          </div>
          <AnimatedButton
            type="button"
            scale={1.015}
            tapScale={0.97}
            className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-canvas-border bg-canvas-surface px-3 text-[11px] font-medium text-canvas-text-secondary transition-colors duration-150 hover:border-indigo-400/35 hover:bg-indigo-500/10 hover:text-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/45"
            onClick={() => void downloadDeveloperGuide()}
          >
            <Icon icon="lucide:download" width={14} height={14} className="shrink-0" />
            <span className="hidden sm:inline">下载 Markdown</span>
            <span className="sm:hidden">下载</span>
          </AnimatedButton>
          <PopupCloseButton ariaLabel="关闭插件开发规范" onClick={() => setGuideOpen(false)} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-[12px] leading-6 text-canvas-text-secondary sm:px-7 sm:py-6">
          <ChatMarkdown value={pluginDeveloperGuide} />
        </div>
      </ModalOverlay>
    </div>
  );
}
