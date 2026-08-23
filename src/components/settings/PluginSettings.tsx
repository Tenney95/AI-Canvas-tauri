import { Icon } from '@iconify/react';
import { useRef, useState } from 'react';
import pluginDeveloperGuide from '../../../doc/插件开发规范.md?raw';
import { isTauriEnv, saveBinaryToLocalFile } from '../../services/fileService';
import { useAppStore } from '../../store/useAppStore';
import { getNodeTypeConfig } from '../../types';
import type { PluginCategory } from '../../types/plugin';
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
  permissions: ['node.read', 'node.write'],
  contributes: {
    nodeTools: [{
      id: 'uppercase-output',
      title: '输出转大写',
      description: '把当前节点的 output 转为大写',
      placements: ['node-context-menu'],
      nodeTypes: ['ai-text', 'source-text'],
      inputFields: ['output'],
      output: { mode: 'update-current', fields: ['output'] },
    }],
  },
}, null, 2);

const EXAMPLE_SOURCE = `definePlugin({
  tools: {
    "uppercase-output": (input) => ({
      data: { output: String(input.node.data.output || "").toUpperCase() },
      message: "已将节点输出转换为大写"
    })
  }
});`;

const PLUGIN_GUIDE_FILE_NAME = 'AI-Canvas-插件开发规范.md';

function folderPrefix(file: File): string {
  const path = file.webkitRelativePath || file.name;
  return path.slice(0, Math.max(0, path.length - file.name.length));
}

export default function PluginSettings() {
  const inputRef = useRef<HTMLInputElement>(null);
  const plugins = useAppStore((state) => state.installedPlugins);
  const installPluginBundle = useAppStore((state) => state.installPluginBundle);
  const setPluginEnabled = useAppStore((state) => state.setPluginEnabled);
  const deletePlugin = useAppStore((state) => state.deletePlugin);
  const showToast = useAppStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

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

  const installFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const all = Array.from(files);
      const manifests = all.filter((file) => file.name === 'manifest.json');
      if (manifests.length !== 1) throw new Error('插件文件夹必须且只能包含一个 manifest.json');
      const manifestFile = manifests[0];
      const prefix = folderPrefix(manifestFile);
      const entryFile = all.find((file) => (file.webkitRelativePath || file.name) === `${prefix}main.js`);
      if (!entryFile) throw new Error('manifest.json 同级目录缺少 main.js');
      await installPluginBundle(await manifestFile.text(), await entryFile.text());
    } catch (error) {
      showToast(error instanceof Error ? error.message : '插件安装失败', 'error');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-canvas-border bg-canvas-card p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-canvas-text">用户插件</h3>
            <p className="mt-1 text-[11px] leading-5 text-canvas-text-muted">
              导入包含 manifest.json 和 main.js 的文件夹。安装前会校验用途、入口位置、节点范围及读写字段。
            </p>
          </div>
          <AnimatedButton
            type="button"
            className="settings-save-btn shrink-0 text-xs"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            <Icon icon="lucide:folder-up" width={14} height={14} />
            {busy ? '校验中…' : '导入插件文件夹'}
          </AnimatedButton>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            multiple
            {...({ webkitdirectory: '' } as Record<string, string>)}
            onChange={(event) => void installFiles(event.currentTarget.files)}
          />
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
        <div className="mt-2 flex items-center justify-between rounded-lg border border-canvas-border bg-canvas-surface px-3 py-2">
          <div className="min-w-0">
            <div className="text-xs font-medium text-canvas-text">开发者示例</div>
            <div className="mt-0.5 text-[11px] text-canvas-text-muted">为文本节点安装“输出转大写”右键工具</div>
          </div>
          <AnimatedButton
            type="button"
            className="rounded-md px-2.5 py-1.5 text-xs text-indigo-400 hover:bg-indigo-500/10"
            onClick={() => void installPluginBundle(EXAMPLE_MANIFEST, EXAMPLE_SOURCE).catch((error) => {
              showToast(error instanceof Error ? error.message : '示例插件安装失败', 'error');
            })}
          >
            安装示例
          </AnimatedButton>
        </div>
      </section>

      <section className="space-y-2">
        {plugins.map((plugin) => {
          const nodeTypes = [...new Set(plugin.manifest.contributes.nodeTools.flatMap((tool) => tool.nodeTypes))];
          const inputFields = [...new Set(plugin.manifest.contributes.nodeTools.flatMap((tool) => tool.inputFields))];
          const outputFields = [...new Set(plugin.manifest.contributes.nodeTools.flatMap((tool) => tool.output.fields))];
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
                  </div>
                  <div className="mt-2 text-[10px] leading-4 text-canvas-text-muted">
                    入口：节点右键菜单 · 工具 {plugin.manifest.contributes.nodeTools.length} 个<br />
                    读取：{inputFields.join('、') || '无'} · 写入：{outputFields.join('、') || '无'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <AnimatedButton
                    type="button"
                    role="switch"
                    aria-checked={plugin.enabled}
                    className={`rounded-md px-2 py-1 text-[11px] ${plugin.enabled ? 'bg-emerald-500/10 text-emerald-400' : 'bg-canvas-surface text-canvas-text-muted'}`}
                    onClick={() => void setPluginEnabled(plugin.id, !plugin.enabled).catch((error) => {
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
                      if (!window.confirm(`确定卸载插件「${plugin.manifest.name}」吗？`)) return;
                      void deletePlugin(plugin.id).catch((error) => {
                        showToast(error instanceof Error ? error.message : '插件卸载失败', 'error');
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
