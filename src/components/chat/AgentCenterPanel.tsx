/**
 * AgentCenterPanel — AI 助手内的全局智能体安装与管理面板。
 *
 * 默认助手始终可用；外部智能体上传失败只在本面板提示，不改变聊天、画布或项目状态。
 */
import { lazy, Suspense, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import { useAppStore } from '../../store/useAppStore';
import type {
  AgentPackageHealth,
  AgentPackageInstallation,
  AgentSourcePreview,
} from '../../types/agentPackage';
import {
  removeAgentPackageSource,
  selectAgentPackageArchive,
  selectAgentPackageFolder,
} from '../../services/agentPackages/agentPackageImportService';
import { confirmAction } from '../../services/confirmDialog';
import PopupCloseButton from '../shared/PopupCloseButton';
import AnimatedButton from '../shared/AnimatedButton';
import { useT } from '../../i18n';

const CreationProfileManager = lazy(() => import('../shared/creationProfiles/CreationProfileManager'));

interface AgentCenterPanelProps {
  onClose: () => void;
  /** 只有主窗口能安装或修改全局目录；独立窗口只能显示投影。 */
  allowInstall?: boolean;
}

const HEALTH_LABELS: Record<AgentPackageHealth, string> = {
  ready: '可用',
  degraded: '受限',
  invalid: '无效',
  missing: '来源丢失',
};

const HEALTH_CLASSES: Record<AgentPackageHealth, string> = {
  ready: 'ui-badge--success',
  degraded: 'ui-badge--warning',
  invalid: 'ui-badge--danger',
  missing: 'ui-badge--danger',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

interface OutlineEntry {
  name: string;
  path: string;
  children: Map<string, OutlineEntry>;
}

function buildOutline(paths: string[]): OutlineEntry[] {
  const root = new Map<string, OutlineEntry>();
  for (const path of paths) {
    const segments = path.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
    let children = root;
    segments.forEach((name, index) => {
      let entry = children.get(name);
      if (!entry) {
        entry = { name, path: segments.slice(0, index + 1).join('/'), children: new Map() };
        children.set(name, entry);
      }
      children = entry.children;
    });
  }
  return [...root.values()];
}

function OutlineItems({ entries }: { entries: OutlineEntry[] }) {
  return (
    <ul className="min-w-0 space-y-1">
      {entries.map((entry) => {
        const children = [...entry.children.values()];
        const isSkill = children.length === 1 && children[0].name.toLowerCase() === 'skill.md';
        return (
          <li key={entry.path} className="min-w-0">
            {children.length > 0 && !isSkill ? (
              <details open className="min-w-0">
                <summary className="cursor-pointer rounded py-1 text-[11px] font-medium text-canvas-text-secondary hover:bg-canvas-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                  <span className="break-all">{entry.name}</span>
                </summary>
                <div className="ml-1 border-l border-canvas-border pl-2">
                  <OutlineItems entries={children} />
                </div>
              </details>
            ) : (
              <div className="flex min-w-0 items-start gap-1.5 rounded py-1 text-[11px] leading-4">
                <Icon icon={isSkill || entry.name.toLowerCase() === 'skill.md' ? 'lucide:sparkles' : 'lucide:file-text'} width="13" className="mt-0.5 shrink-0 text-canvas-text-muted" />
                <span className="min-w-0 break-all text-canvas-text-secondary">{entry.name}</span>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function AgentPackageCard({
  installation,
  busy,
  allowInstall,
  onToggle,
  onToggleMcpSkillRead,
  onRemove,
}: {
  installation: AgentPackageInstallation;
  busy: boolean;
  allowInstall: boolean;
  onToggle: () => void;
  onToggleMcpSkillRead: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const name = installation.manifest.name || installation.source.displayName;
  const outline = useMemo(() => buildOutline(installation.entrypoints), [installation.entrypoints]);
  return (
    <article className="ui-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-canvas-surface text-brand">
          <Icon icon="lucide:bot" width="16" height="16" />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="break-words text-sm font-medium text-canvas-text [overflow-wrap:anywhere]">{name}</h4>
        </div>
        {allowInstall && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              role="switch"
              aria-checked={installation.enabled}
              aria-label={installation.enabled
                ? t('停用智能体 {name}', { name })
                : t('启用智能体 {name}', { name })}
              disabled={busy}
              onClick={onToggle}
              className={`ui-btn ui-btn--ghost ui-btn--sm ${installation.enabled ? 'is-active' : ''}`}
            >
              {t(installation.enabled ? '已启用' : '已停用')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onRemove}
              aria-label={t('移除智能体 {name}', { name })}
              className="ui-btn ui-btn--ghost ui-btn--sm"
            >
              <Icon icon="mdi:trash-can-outline" width="14" />
            </button>
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="ui-badge">v{installation.manifest.version}</span>
        <span className={`ui-badge ${HEALTH_CLASSES[installation.health]}`}>
          {t(HEALTH_LABELS[installation.health])}
        </span>
      </div>
      {installation.manifest.description && (
        <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-canvas-text-secondary">
          {installation.manifest.description}
        </p>
      )}
      <p className="mt-1.5 text-[10px] leading-4 text-canvas-text-muted">
        {installation.source.sourceType === 'folder' ? t('链接文件夹') : t('托管压缩包')}
        {' · '}{t('{count} 个 Skill', { count: installation.skillCount })}
        {' · '}{t('{count} 个文件', { count: installation.fileCount })}
        {' · '}{formatBytes(installation.totalBytes)}
      </p>
      {installation.warnings.length > 0 && (
        <div className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/5 px-2.5 py-2 text-[10px] leading-4 text-amber-200">
          <div className="mb-1 flex items-center gap-1 font-medium">
            <Icon icon="mdi:alert-outline" width="12" />
            {t('{count} 条预检提醒', { count: installation.warnings.length })}
          </div>
          <ul className="list-disc space-y-0.5 pl-4">
            {installation.warnings.slice(0, 3).map((warning, index) => (
              <li key={`${installation.id}-warning-${index}`} className="break-words">{warning}</li>
            ))}
          </ul>
        </div>
      )}
      {allowInstall && (
        <div className="mt-2 flex items-start justify-between gap-3 rounded-lg border border-canvas-border bg-canvas-surface px-2.5 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-canvas-text-secondary">{t('MCP 只读')}</p>
            <p className="mt-0.5 text-[10px] leading-4 text-canvas-text-muted">
              {t('仅允许 MCP 客户端列出、加载和读取该智能体中的 Skill，不会执行包内脚本。')}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={installation.enabled && installation.mcpSkillReadEnabled}
            aria-label={installation.mcpSkillReadEnabled
              ? t('禁止 MCP 读取智能体 {name} 的 Skill', { name })
              : t('允许 MCP 读取智能体 {name} 的 Skill', { name })}
            disabled={busy || !installation.enabled}
            onClick={onToggleMcpSkillRead}
            className={`ui-btn ui-btn--ghost ui-btn--sm shrink-0 ${
              installation.enabled && installation.mcpSkillReadEnabled
                ? 'is-active'
                : ''
            }`}
          >
            {t(installation.enabled && installation.mcpSkillReadEnabled ? '已允许' : '未允许')}
          </button>
        </div>
      )}
      <details className="group/outline mt-3 min-w-0 border-t border-canvas-border pt-2">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded py-1 text-xs font-medium text-canvas-text-secondary hover:bg-canvas-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
          <Icon icon="lucide:chevron-right" width="14" className="shrink-0 transition-transform group-open/outline:rotate-90" />
          {t('智能体大纲')}
        </summary>
        <p className="my-2 text-[10px] leading-4 text-canvas-text-muted">{t('按安装时识别的入口与 Skill 目录展示。')}</p>
        {outline.length > 0 ? <OutlineItems entries={outline} /> : (
          <p className="py-2 text-[11px] text-canvas-text-muted">{t('暂无内容')}</p>
        )}
      </details>
    </article>
  );
}

export default function AgentCenterPanel({ onClose, allowInstall = false }: AgentCenterPanelProps) {
  const t = useT();
  const agentPackages = useAppStore((state) => state.agentPackages);
  const agentCatalogStatus = useAppStore((state) => state.agentCatalogStatus);
  const agentCatalogErrorCode = useAppStore((state) => state.agentCatalogErrorCode);
  const agentPackageSkillCatalogErrorCode = useAppStore(
    (state) => state.agentPackageSkillCatalogErrorCode,
  );
  const installAgentPackagePreview = useAppStore((state) => state.installAgentPackagePreview);
  const setAgentPackageEnabled = useAppStore((state) => state.setAgentPackageEnabled);
  const setAgentPackageMcpSkillReadEnabled = useAppStore(
    (state) => state.setAgentPackageMcpSkillReadEnabled,
  );
  const removeAgentPackageRecord = useAppStore((state) => state.removeAgentPackageRecord);
  const showToast = useAppStore((state) => state.showToast);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [localError, setLocalError] = useState('');
  const [profilesOpen, setProfilesOpen] = useState(false);

  const removeSourceBestEffort = async (sourceId: string) => {
    try {
      await removeAgentPackageSource(sourceId);
    } catch {
      // 目录记录已是权威状态；原生注册/托管副本可在后续健康检查中重试清理。
      console.warn('[Agent Center] 智能体来源清理失败');
    }
  };

  const importPackage = async (source: 'folder' | 'archive') => {
    if (!allowInstall || busyKey) return;
    setBusyKey(`import:${source}`);
    setLocalError('');
    let preview: AgentSourcePreview | null = null;
    let sourceAlreadyInstalled = false;
    try {
      const installationsBeforeImport = useAppStore.getState().agentPackages;
      preview = source === 'folder'
        ? await selectAgentPackageFolder()
        : await selectAgentPackageArchive();
      if (!preview) return;
      sourceAlreadyInstalled = installationsBeforeImport.some(
        (installation) => installation.source.sourceId === preview?.sourceId,
      );
      const installed = await installAgentPackagePreview(preview);
      const replaced = installationsBeforeImport.find(
        (installation) => installation.id === installed.id,
      );
      if (replaced && replaced.source.sourceId !== installed.source.sourceId) {
        await removeSourceBestEffort(replaced.source.sourceId);
      }
      showToast(t('已安装智能体「{name}」', { name: preview.name }));
    } catch (error) {
      if (preview && !sourceAlreadyInstalled) {
        await removeSourceBestEffort(preview.sourceId);
      }
      const message = error instanceof Error ? error.message : t('智能体上传失败');
      setLocalError(message);
      showToast(message, 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const togglePackage = async (installation: AgentPackageInstallation) => {
    if (!allowInstall || busyKey) return;
    setBusyKey(`toggle:${installation.id}`);
    setLocalError('');
    try {
      await setAgentPackageEnabled(installation.id, !installation.enabled);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('智能体状态保存失败');
      setLocalError(message);
      showToast(message, 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const removePackage = async (installation: AgentPackageInstallation) => {
    if (!allowInstall || busyKey) return;
    const name = installation.manifest.name || installation.source.displayName;
    if (!(await confirmAction(t('确定从软件中移除智能体「{name}」？外部文件不会被删除。', { name }), { title: t('移除智能体') }))) return;
    setBusyKey(`remove:${installation.id}`);
    setLocalError('');
    try {
      await removeAgentPackageRecord(installation.id);
      await removeSourceBestEffort(installation.source.sourceId);
      showToast(t('已移除智能体「{name}」', { name }));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('移除智能体失败');
      setLocalError(message);
      showToast(message, 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const toggleMcpSkillRead = async (installation: AgentPackageInstallation) => {
    if (!allowInstall || busyKey || !installation.enabled) return;
    setBusyKey(`mcp:${installation.id}`);
    setLocalError('');
    try {
      await setAgentPackageMcpSkillReadEnabled(
        installation.id,
        !installation.mcpSkillReadEnabled,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : t('智能体 MCP 权限保存失败');
      setLocalError(message);
      showToast(message, 'error');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-canvas-bg">
      <div className="flex items-center justify-between border-b border-canvas-border px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon icon="lucide:bot" width="16" className="shrink-0 text-brand" />
          <span className="truncate text-sm font-medium text-canvas-text">{t('智能体中心')}</span>
          <span className="shrink-0 text-[11px] text-canvas-text-muted">
            {t('{count} 个已安装', { count: agentPackages.length })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {allowInstall && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setProfilesOpen(true)}>{t('创作组合包')}</button>}
          <PopupCloseButton onClick={onClose} />
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto overflow-x-hidden p-3">
        <section className="rounded-xl border border-indigo-400/20 bg-indigo-400/5 p-3">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-300">
              <Icon icon="mdi:creation-outline" width="18" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <h4 className="text-sm font-medium text-canvas-text">{t('默认助手')}</h4>
                <span className="rounded bg-emerald-400/10 px-1.5 py-0.5 text-[10px] text-emerald-300">{t('始终可用')}</span>
              </div>
              <p className="mt-1 text-[11px] leading-4 text-canvas-text-secondary">
                {t('不安装智能体也能继续使用聊天、画布、工作流和模型功能。')}
              </p>
            </div>
          </div>
        </section>

        {allowInstall && (
          <section className="rounded-xl border border-canvas-border bg-canvas-card p-3">
            <h3 className="text-xs font-medium text-canvas-text">{t('上传智能体')}</h3>
            <p className="mt-1 text-[11px] leading-4 text-canvas-text-muted">
              {t('文件夹会保持只读链接；压缩包会导入软件管理目录。上传只做预检，不会执行包内脚本。')}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <AnimatedButton
                type="button"
                disabled={busyKey !== null}
                onClick={() => void importPackage('folder')}
                className="flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-xl border border-canvas-border
                           bg-canvas-surface px-3 py-2 text-xs text-canvas-text-secondary hover:border-brand/40 hover:text-canvas-text
                           disabled:cursor-wait disabled:opacity-50"
              >
                <Icon icon={busyKey === 'import:folder' ? 'mdi:loading' : 'mdi:folder-plus-outline'} width="20" className={busyKey === 'import:folder' ? 'animate-spin' : ''} />
                {t('选择文件夹')}
              </AnimatedButton>
              <AnimatedButton
                type="button"
                disabled={busyKey !== null}
                onClick={() => void importPackage('archive')}
                className="flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-xl border border-canvas-border
                           bg-canvas-surface px-3 py-2 text-xs text-canvas-text-secondary hover:border-brand/40 hover:text-canvas-text
                           disabled:cursor-wait disabled:opacity-50"
              >
                <Icon icon={busyKey === 'import:archive' ? 'mdi:loading' : 'mdi:archive-arrow-up-outline'} width="20" className={busyKey === 'import:archive' ? 'animate-spin' : ''} />
                {t('选择压缩包')}
              </AnimatedButton>
            </div>
            <p className="mt-2 text-center text-[10px] text-canvas-text-muted">
              {t('支持 .aicanvas-agent、.tgz 和 .tar.gz')}
            </p>
          </section>
        )}

        {(localError || agentCatalogErrorCode || agentPackageSkillCatalogErrorCode) && (
          <div role="alert" className="rounded-lg border border-red-400/20 bg-red-400/5 px-3 py-2 text-[11px] leading-4 text-red-300">
            {localError || t('智能体目录当前受限（{code}）', {
              code: agentCatalogErrorCode || agentPackageSkillCatalogErrorCode || 'unknown',
            })}
          </div>
        )}

        {agentCatalogStatus === 'loading' && agentPackages.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-canvas-text-muted">
            <Icon icon="mdi:loading" width="16" className="animate-spin" />
            {t('正在读取智能体目录…')}
          </div>
        ) : agentPackages.length === 0 ? (
          <div className="rounded-xl border border-dashed border-canvas-border px-4 py-7 text-center">
            <Icon icon="lucide:bot-off" width="28" className="mx-auto text-canvas-text-muted/50" />
            <p className="mt-2 text-xs text-canvas-text-secondary">{t('还没有安装外部智能体')}</p>
            <p className="mt-1 text-[10px] leading-4 text-canvas-text-muted">
              {t('这不会影响默认助手和软件其他功能。')}
            </p>
          </div>
        ) : (
          <section className="space-y-2">
            {agentPackages.map((installation) => (
              <AgentPackageCard
                key={installation.id}
                installation={installation}
                busy={busyKey === `toggle:${installation.id}`
                  || busyKey === `mcp:${installation.id}`
                  || busyKey === `remove:${installation.id}`}
                allowInstall={allowInstall}
                onToggle={() => void togglePackage(installation)}
                onToggleMcpSkillRead={() => void toggleMcpSkillRead(installation)}
                onRemove={() => void removePackage(installation)}
              />
            ))}
          </section>
        )}
      </div>
      {allowInstall && profilesOpen && <Suspense fallback={<p role="status" className="ui-hint p-3">{t('正在加载创作组合包…')}</p>}><CreationProfileManager onClose={() => setProfilesOpen(false)} /></Suspense>}
    </div>
  );
}
