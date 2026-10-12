import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { setLocale, useT } from '../../i18n';
import { applyAppearanceTheme, installSystemAppearanceListener } from '../../services/appearance/appearanceRuntime';
import {
  applyComfyRepositoryAction, getComfyManagementSnapshot, installComfyDependencies,
  installComfyExtension, listComfyCatalog,
} from '../../services/comfyManagementService';
import type { ComfyCatalogEntry, ComfyManagementSnapshot, ComfyRepository, ComfyRepositoryAction } from '../../types/comfyManagement';
import ModalOverlay from '../shared/ModalOverlay';
import Tabs from '../shared/Tabs';
import ComfyVersionList from './ComfyVersionList';
import ComfyLaunchSettings from './ComfyLaunchSettings';

type Tab = 'core' | 'extensions' | 'catalog' | 'settings';
interface Confirmation { title: string; detail: string; operation: () => Promise<string> }
const TABS = [
  { id: 'core', label: '内核版本', icon: 'lucide:history' },
  { id: 'extensions', label: '已装插件', icon: 'lucide:blocks' },
  { id: 'catalog', label: '安装插件', icon: 'lucide:download' },
  { id: 'settings', label: '常用设置', icon: 'lucide:sliders-horizontal' },
] as const;

function RepositorySummary({ repository }: { repository: ComfyRepository }) {
  const t = useT();
  return <dl className="ui-card p-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
    <dt className="text-canvas-text-muted">{t('远端地址')}</dt><dd className="break-all select-text">{repository.remoteUrl || t('非 Git 安装')}</dd>
    <dt className="text-canvas-text-muted">{t('当前分支')}</dt><dd className="font-mono">{repository.branch || t('独立版本（detached HEAD）')}</dd>
    <dt className="text-canvas-text-muted">{t('当前版本')}</dt><dd className="font-mono break-all">{repository.commit || t('暂无')}{repository.commitDate ? ` · ${repository.commitDate}` : ''}</dd>
  </dl>;
}

export default function ComfyManagementWindow() {
  const t = useT();
  const [tab, setTab] = useState<Tab>('core');
  const [snapshot, setSnapshot] = useState<ComfyManagementSnapshot | null>(null);
  const [busy, setBusy] = useState(() => t('读取安装信息'));
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [search, setSearch] = useState('');
  const [catalog, setCatalog] = useState<ComfyCatalogEntry[] | null>(null);
  const [catalogLimit, setCatalogLimit] = useState(80);
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [versionRepository, setVersionRepository] = useState<ComfyRepository | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const busyRef = useRef(true);
  const aliveRef = useRef(true);
  const themeCleanup = useRef<() => void>(() => {});

  const refreshSnapshot = useCallback(async (isCurrent?: () => boolean) => {
    const next = await getComfyManagementSnapshot();
    if (!aliveRef.current || (isCurrent && !isCurrent())) return;
    applyAppearanceTheme(next.uiContext.appearance);
    themeCleanup.current();
    themeCleanup.current = installSystemAppearanceListener(() => applyAppearanceTheme(next.uiContext.appearance));
    setLocale(next.uiContext.language);
    document.documentElement.toggleAttribute('data-native-cursor', next.uiContext.nativeCursor);
    setSnapshot(next);
  }, []);
  const run = useCallback(async (label: string, operation: () => Promise<string>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(label); setFeedback(null);
    try {
      const message = await operation();
      if (aliveRef.current && message) setFeedback({ text: message, error: false });
      return true;
    } catch (error) {
      if (aliveRef.current) setFeedback({ text: error instanceof Error ? error.message : String(error), error: true });
      return false;
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy('');
    }
  }, []);
  useEffect(() => {
    let active = true;
    aliveRef.current = true;
    document.title = 'ComfyUI · 版本、插件与设置';
    void refreshSnapshot(() => active).catch((error: unknown) => {
      if (active && aliveRef.current) setFeedback({ text: error instanceof Error ? error.message : String(error), error: true });
    }).finally(() => {
      if (!active || !aliveRef.current) return;
      busyRef.current = false;
      setBusy('');
    });
    return () => { active = false; aliveRef.current = false; themeCleanup.current(); };
  }, [refreshSnapshot]);

  const mutate = async (request: ComfyRepositoryAction) => {
    const result = await applyComfyRepositoryAction(request);
    await refreshSnapshot();
    setCatalog(null);
    setVersionRepository(null);
    return result.message;
  };
  const switchVersion = (repository: ComfyRepository, reference: string, title: string) => setConfirmation({
    title: t('切换版本'),
    detail: t('将 {name} 切换到 {version}。请先停止 ComfyUI，完成后重新启动；已有工作流可能需要兼容的新版本插件。', { name: repository.name, version: title }),
    operation: () => mutate({ repositoryId: repository.id, action: 'switch', reference }),
  });
  const loadCatalog = () => run(t('读取插件目录'), async () => {
    const next = await listComfyCatalog();
    if (aliveRef.current) { setCatalog(next); setCatalogLimit(80); }
    return t('插件目录已刷新');
  });
  const install = (url: string, name: string) => setConfirmation({
    title: t('安装插件'),
    detail: t('将安装 {name}，初始状态为停用。安装后可显式安装依赖，再启用并重启 ComfyUI。仅安装你信任的插件。', { name }),
    operation: async () => {
      const result = await installComfyExtension(url);
      await refreshSnapshot(); setCatalog(null);
      return result.message;
    },
  });
  const updateAll = () => setConfirmation({
    title: t('一键更新'),
    detail: t('依次更新内核和已启用的 Git 插件。有本地修改、独立版本或更新失败时停止，已完成项会保留。请先停止 ComfyUI。'),
    operation: async () => {
      if (!snapshot) return '';
      const repositories = [snapshot.core, ...snapshot.extensions].filter((repository): repository is ComfyRepository => !!repository && repository.isGit && repository.enabled && !repository.removed);
      let completed = 0;
      try {
        for (const repository of repositories) {
          setBusy(t('正在更新 {name}', { name: repository.name }));
          await applyComfyRepositoryAction({ repositoryId: repository.id, action: 'update' });
          completed += 1;
        }
      } catch (cause) {
        throw new Error(t('已更新 {count} 项，后续更新停止：{reason}', { count: completed, reason: String(cause) }), { cause });
      } finally { await refreshSnapshot(); setCatalog(null); }
      return t('已更新 {count} 项，请重新启动 ComfyUI', { count: completed });
    },
  });
  const filteredExtensions = snapshot?.extensions.filter((repository) => `${repository.name} ${repository.remoteUrl ?? ''}`.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  const filteredCatalog = catalog?.filter((entry) => `${entry.name} ${entry.description}`.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  const isInstalled = (entry: ComfyCatalogEntry) => entry.installed || !!snapshot?.extensions.some((repository) => !repository.removed && repository.remoteUrl?.replace(/\.git\/?$/, '').replace(/\/$/, '') === entry.repositoryUrl.replace(/\.git\/?$/, '').replace(/\/$/, ''));
  const isPluginTab = tab === 'extensions' || tab === 'catalog';

  return <div className="fixed inset-0 flex flex-col bg-canvas-bg text-canvas-text">
    <header className="shrink-0 border-b border-canvas-border bg-canvas-surface p-3 space-y-3">
      <div className="ui-row ui-row--between"><div className="min-w-0"><h1 className="text-base font-semibold">ComfyUI {t('管理')}</h1><p className="ui-hint break-all">{snapshot?.installationName || t('本地安装管理')}</p></div>
        <div className="ui-row"><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={!!busy} onClick={() => void run(t('刷新列表'), async () => { await refreshSnapshot(); return t('安装信息已刷新'); })}><Icon icon="lucide:refresh-cw" width={14} />{t('刷新列表')}</button>
          <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={!!busy || !snapshot?.gitAvailable} onClick={updateAll}><Icon icon="lucide:package-check" width={14} />{t('一键更新')}</button></div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Tabs<Tab> aria-label={t('ComfyUI 管理分类')} value={tab} className="min-w-0 flex-1 basis-96"
          items={TABS.map((item) => ({ value: item.id, label: <><Icon icon={item.icon} width={15} />{t(item.label)}</>, disabled: !!busy }))}
          onChange={(next) => { setTab(next); setSearch(''); if (next === 'catalog' && !catalog) void loadCatalog(); }} />
        {isPluginTab && <div className="ml-auto flex w-80 max-w-full shrink-0 items-center gap-2">
          <input className="ui-input ui-input--sm min-w-0 flex-1" type="search"
            aria-label={tab === 'extensions' ? t('搜索已装插件') : t('搜索新插件')}
            placeholder={tab === 'extensions' ? t('搜索已装插件…') : t('搜索新插件…')}
            value={search} onChange={(event) => { setSearch(event.target.value); if (tab === 'catalog') setCatalogLimit(80); }} />
          {tab === 'catalog' && <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm shrink-0" disabled={!!busy} onClick={() => void loadCatalog()}>{t('刷新目录')}</button>}
        </div>}
      </div>
    </header>
    <main className={`flex-1 min-h-0 min-w-0 p-3 ${isPluginTab ? 'flex flex-col gap-3 overflow-hidden' : 'ui-scroll space-y-3'}`} aria-busy={!!busy}>
      <div className="shrink-0 space-y-3">
        <div className="ui-alert ui-alert--info"><Icon icon="lucide:info" width={16} className="ui-alert__icon" /><div className="ui-alert__body">{t('管理操作只作用于当前安装目录。修改版本或插件前请停止 ComfyUI，完成后重新启动。插件依赖需单独安装。')}</div></div>
        {!!busy && <div className="ui-row text-xs text-canvas-text-secondary" role="status"><Icon icon="lucide:loader-circle" width={14} className="animate-spin" />{busy}…</div>}
        {feedback && <div className={`ui-alert ${feedback.error ? 'ui-alert--danger' : 'ui-alert--success'}`} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</div>}
        {!!snapshot?.warnings.length && <div className="ui-alert ui-alert--warning">
          <Icon icon="lucide:triangle-alert" width={16} className="ui-alert__icon" />
          <details className="ui-alert__body flex-1">
            <summary className="cursor-pointer font-medium">{t('发现 {count} 条管理提示，点击查看', { count: snapshot.warnings.length })}</summary>
            <ul className="mt-2 space-y-1 max-h-40 ui-scroll text-xs">{snapshot.warnings.map((warning, index) => <li key={index} className="break-words">{warning}</li>)}</ul>
          </details>
        </div>}
      </div>
      {!snapshot && !busy && <div className="ui-empty"><Icon icon="lucide:folder-search" width={28} className="ui-empty__icon" /><p className="ui-empty__title">{t('无法读取安装信息')}</p><p className="ui-empty__desc">{t('请在主窗口重新选择 ComfyUI 安装目录，再打开管理窗口。')}</p></div>}
      {snapshot && tab === 'core' && (snapshot.core ? <>
        <RepositorySummary repository={snapshot.core} />
        <div className="ui-row">
          <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={!!busy || !snapshot.core.isGit || snapshot.core.dirty || !snapshot.core.branch} onClick={() => void run(t('更新内核'), () => mutate({ repositoryId: 'core', action: 'update' }))}>{t('更新当前分支')}</button>
          <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={!!busy} onClick={() => void run(t('安装内核依赖'), async () => (await installComfyDependencies('core')).message)}>{t('安装内核依赖')}</button>
        </div>
        {snapshot.core.isGit ? <ComfyVersionList key={`${snapshot.core.id}:${snapshot.core.commit}`} repository={snapshot.core} busy={!!busy} onSwitch={(reference, title) => switchVersion(snapshot.core!, reference, title)} /> : <div className="ui-empty"><p className="ui-empty__title">{t('当前内核不是 Git 安装')}</p><p className="ui-empty__desc">{t('可管理自定义节点和启动设置；该安装不支持内核版本切换。')}</p></div>}
      </> : <div className="ui-empty"><p className="ui-empty__title">{t('未找到 ComfyUI 内核')}</p></div>)}
      {snapshot && tab === 'extensions' && <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div role="region" aria-label={t('已装插件列表')} tabIndex={0} className="min-h-0 min-w-0 flex-1 ui-scroll ui-scroll--both rounded-lg border border-canvas-border focus-visible:outline focus-visible:outline-1 focus-visible:outline-brand"><table className="ui-table"><thead className="sticky top-0 z-10 bg-canvas-surface"><tr><th>{t('启用')}</th><th>{t('插件名 / 远端地址')}</th><th>{t('当前分支')}</th><th>{t('版本 ID / 日期')}</th><th>{t('操作')}</th></tr></thead><tbody>
          {filteredExtensions.map((repository) => <tr key={repository.id}>
            <td>{repository.removed ? <span className="ui-badge ui-badge--outline">{t('已卸载')}</span> : <button type="button" className="ui-switch" role="switch" aria-checked={repository.enabled} aria-label={t('启用 {name}', { name: repository.name })} disabled={!!busy} onClick={() => void run(t('修改插件状态'), () => mutate({ repositoryId: repository.id, action: repository.enabled ? 'disable' : 'enable' }))} />}</td>
            <td className="max-w-xs"><div className="font-medium break-all">{repository.name}</div><div className="text-canvas-text-muted text-[11px] truncate" title={repository.remoteUrl ?? ''}>{repository.remoteUrl || t('非 Git 安装')}</div>{repository.dirty && <span className="ui-badge ui-badge--warning mt-1">{t('有本地修改')}</span>}</td>
            <td className="font-mono text-xs">{repository.branch || '—'}</td><td className="text-xs"><div className="font-mono">{repository.commit?.slice(0, 8) || '—'}</div><div className="text-canvas-text-muted whitespace-nowrap">{repository.commitDate || '—'}</div></td>
            <td><div className="ui-row ui-row--tight flex-nowrap">
              {repository.removed ? <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={!!busy} onClick={() => void run(t('恢复插件'), () => mutate({ repositoryId: repository.id, action: 'restore' }))}>{t('恢复')}</button> : <>
                <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={!!busy || !repository.isGit || repository.dirty || !repository.branch} onClick={() => void run(t('更新插件'), () => mutate({ repositoryId: repository.id, action: 'update' }))}>{t('更新')}</button>
                <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={!!busy || !repository.isGit} onClick={() => setVersionRepository(repository)}>{t('切换版本')}</button>
                <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={!!busy} onClick={() => void run(t('安装依赖'), async () => (await installComfyDependencies(repository.id)).message)}>{t('安装依赖')}</button>
                <button type="button" className="ui-btn ui-btn--danger ui-btn--sm" disabled={!!busy} onClick={() => setConfirmation({ title: t('卸载插件'), detail: t('将 {name} 移到本安装的恢复目录，不永久删除；可在列表中恢复。请先停止 ComfyUI。', { name: repository.name }), operation: () => mutate({ repositoryId: repository.id, action: 'uninstall' }) })}>{t('卸载')}</button>
              </>}
            </div></td>
          </tr>)}
          {!filteredExtensions.length && <tr><td colSpan={5} className="text-canvas-text-muted">{t('暂无匹配插件')}</td></tr>}
        </tbody></table></div>
      </section>}
      {snapshot && tab === 'catalog' && <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        {catalog && <div role="region" aria-label={t('可安装插件列表')} tabIndex={0} className="min-h-0 min-w-0 flex-1 ui-scroll ui-scroll--both rounded-lg border border-canvas-border focus-visible:outline focus-visible:outline-1 focus-visible:outline-brand"><table className="ui-table"><thead className="sticky top-0 z-10 bg-canvas-surface"><tr><th>{t('插件名')}</th><th>{t('简介')}</th><th>{t('操作')}</th></tr></thead><tbody>
          {filteredCatalog.slice(0, catalogLimit).map((entry) => <tr key={entry.id}><td className="max-w-xs break-words font-medium">{entry.name}</td><td className="max-w-xl"><p className="text-xs break-words">{entry.description}</p><p className="text-[11px] text-canvas-text-muted break-all mt-1">{entry.repositoryUrl}</p></td><td><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={!!busy || isInstalled(entry) || !snapshot.gitAvailable} onClick={() => install(entry.repositoryUrl, entry.name)}>{isInstalled(entry) ? t('已装') : t('安装')}</button></td></tr>)}
          {!filteredCatalog.length && <tr><td colSpan={3}>{t('暂无匹配插件')}</td></tr>}
        </tbody></table>{filteredCatalog.length > catalogLimit && <div className="p-2"><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => setCatalogLimit((value) => value + 80)}>{t('加载更多')}</button></div>}</div>}
        <form className="ui-card mt-auto min-w-0 shrink-0 p-2" onSubmit={(event) => { event.preventDefault(); install(repositoryUrl.trim(), repositoryUrl.trim()); }}>
          <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
            <label htmlFor="comfy-extension-url" className="ui-label flex items-center gap-1.5 whitespace-nowrap"><Icon icon="lucide:link" width={14} />{t('扩展 URL')}</label>
            <input id="comfy-extension-url" type="url" required className="ui-input ui-input--sm min-w-0" placeholder="https://github.com/owner/ComfyUI-extension" value={repositoryUrl} disabled={!!busy} onChange={(event) => setRepositoryUrl(event.target.value)} />
            <button type="submit" className="ui-btn ui-btn--primary ui-btn--sm min-w-20" disabled={!!busy || !repositoryUrl.trim().startsWith('https://') || !snapshot.gitAvailable}><Icon icon="lucide:download" width={14} />{t('安装')}</button>
          </div>
        </form>
      </section>}
      {snapshot && tab === 'settings' && <ComfyLaunchSettings busy={!!busy} run={run} />}
    </main>
    <ModalOverlay isOpen={!!versionRepository} onClose={() => { if (!busy) setVersionRepository(null); }} ariaLabel={t('插件版本')} className="w-[calc(100%_-_24px)] max-w-5xl max-h-[85vh] bg-canvas-surface" closeOnBackdrop={!busy}>
      {versionRepository && <><div className="ui-row ui-row--between border-b border-canvas-border p-3"><h2 className="text-sm font-semibold">{versionRepository.name} · {t('切换版本')}</h2><button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" aria-label={t('关闭')} disabled={!!busy} onClick={() => setVersionRepository(null)}><Icon icon="lucide:x" width={16} /></button></div><div className="p-3 ui-scroll space-y-3"><RepositorySummary repository={versionRepository} /><ComfyVersionList repository={versionRepository} busy={!!busy} onSwitch={(reference, title) => switchVersion(versionRepository, reference, title)} /></div></>}
    </ModalOverlay>
    <ModalOverlay isOpen={!!confirmation} onClose={() => setConfirmation(null)} ariaLabel={confirmation?.title || t('确认操作')} className="w-[calc(100%_-_24px)] max-w-lg bg-canvas-surface" zIndex={260}>
      {confirmation && <div className="p-3 space-y-3"><h2 className="text-sm font-semibold">{confirmation.title}</h2><p className="text-xs text-canvas-text-secondary leading-relaxed break-words">{confirmation.detail}</p><div className="ui-row justify-end"><button type="button" className="ui-btn ui-btn--secondary" onClick={() => setConfirmation(null)}>{t('取消')}</button><button type="button" className="ui-btn ui-btn--primary" disabled={!!busy} onClick={() => { const pending = confirmation; setConfirmation(null); void run(pending.title, pending.operation); }}>{t('确认')}</button></div></div>}
    </ModalOverlay>
  </div>;
}
