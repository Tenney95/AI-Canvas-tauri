/**
 * VolcengineAssetLibraryPanel — 提供方舟素材库界面与交互。
 */
import { useT } from '../../i18n';
import { getVolcengineAssetStatusLabel } from './volcengineAssetLabels';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { useAppStore } from '../../store/useAppStore';
import { createAssetGroup, deleteAsset, deleteAssetGroup, getAsset, getAssetGroup, listAssetGroups, listAssets, updateAsset, updateAssetGroup } from '../../services/ai/providers/volcengineAssetLibrary';
import { createVolcengineAssetViaTos } from '../../services/ai/providers/volcengineAssetUpload';
import type { VolcengineAsset, VolcengineAssetGroup } from '../../types/volcengineAssetLibrary';
import { readAppSecret } from '../../services/providerSecretService';
import { getAssetUrlFromPath, isTauriEnv } from '../../services/fs/core';
import ViewportImage from '../shared/ViewportImage';
import VideoThumbnail from '../shared/VideoThumbnail';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import Select from '../shared/Select';

type Dialog =
  | { kind: 'create-group' }
  | { kind: 'edit-group'; group: VolcengineAssetGroup }
  | { kind: 'create-asset' }
  | { kind: 'edit-asset'; asset: VolcengineAsset }
  | { kind: 'delete-group'; group: VolcengineAssetGroup }
  | { kind: 'delete-asset'; asset: VolcengineAsset }
  | null;

const PAGE_SIZE = 20;
type AssetType = Parameters<typeof createVolcengineAssetViaTos>[2]['assetType'];

function inferAssetType(url: string): AssetType | undefined {
  const path = url.trim().split(/[?#]/, 1)[0].toLowerCase();
  if (/\.(mp4|mov)$/.test(path)) return 'Video';
  if (/\.(mp3|wav)$/.test(path)) return 'Audio';
  if (/\.(jpe?g|png|webp|tiff?|gif|heic|heif)$/.test(path)) return 'Image';
  return undefined;
}

export default function VolcengineAssetLibraryPanel({ compact = false, onCountChange, onOpenProviderSettings }: { compact?: boolean; onCountChange?: (count: number) => void; onOpenProviderSettings?: () => void }) {
  const t = useT();
  const providerId = useAppStore((state) => state.config.providers.volcengine
    && (!state.config.providers.volcengine.catalogId || state.config.providers.volcengine.catalogId === 'volcengine')
    ? 'volcengine' : Object.entries(state.config.providers).find(([, item]) => item.catalogId === 'volcengine')?.[0]);
  const provider = useAppStore((state) => providerId ? state.config.providers[providerId] : undefined);
  const [groups, setGroups] = useState<VolcengineAssetGroup[]>([]);
  const [assets, setAssets] = useState<VolcengineAsset[]>([]);
  const [selectedGroup, setSelectedGroup] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; vars?: Record<string, string | number> }>({ text: '' });
  const setMessage = useCallback((text: string, vars?: Record<string, string | number>) => setNotice({ text, vars }), []);
  const message = t(notice.text, notice.vars);
  const [dialogError, setDialogError] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [loadedSecretFingerprint, setLoadedSecretFingerprint] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [sourceMode, setSourceMode] = useState<'local' | 'url'>('local');
  const [localSource, setLocalSource] = useState<{ url: string; fileName: string }>();
  const [formAssetType, setFormAssetType] = useState<AssetType | ''>('');
  const [pickingFile, setPickingFile] = useState(false);
  const filePickVersion = useRef(0);
  const pickingFileRef = useRef(false);
  const submittingRef = useRef(false);
  const uploadAbort = useRef<AbortController | null>(null);
  const [formGroupId, setFormGroupId] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [groupPage, setGroupPage] = useState(1);
  const [assetPage, setAssetPage] = useState(1);
  const [groupTotal, setGroupTotal] = useState(0);
  const [assetTotal, setAssetTotal] = useState(0);
  const [dialogProviderId, setDialogProviderId] = useState(providerId);
  if (dialogProviderId !== providerId) {
    setDialogProviderId(providerId);
    setDialog(null); setLocalSource(undefined); setFormUrl(''); setFormAssetType('');
  }
  const enabled = Boolean(provider?.assetLibrary?.enabled);
  const configured = Boolean(accessKeyId && secretAccessKey);
  const tosConfigured = Boolean(provider?.tosUpload?.bucket && provider.tosUpload.credentialRef);
  const resolveSecretRef = (value: string | undefined, fallback: string) => (value?.startsWith('secret:') ? value.slice(7) : value || fallback);
  const accessKeySecretRef = resolveSecretRef(provider?.assetLibrary?.accessKeyIdRef, 'provider/volcengine/asset-library/access-key');
  const secretAccessKeySecretRef = resolveSecretRef(provider?.assetLibrary?.secretAccessKeyRef, 'provider/volcengine/asset-library/secret-key');
  const secretFingerprint = `${accessKeySecretRef}\u0000${secretAccessKeySecretRef}`;
  const secretsLoaded = loadedSecretFingerprint === secretFingerprint;
  const projectName = provider?.assetLibrary?.projectName || 'default'; const region = provider?.assetLibrary?.region || 'cn-beijing';
  const options = useMemo(() => ({ accessKeyId, secretAccessKey, projectName, region, baseUrl: provider?.assetLibrary?.apiBaseUrl }), [accessKeyId, secretAccessKey, projectName, region, provider?.assetLibrary?.apiBaseUrl]);
  const load = useCallback(async (preserveNotice = false) => {
    if (!accessKeyId || !secretAccessKey) { setMessage('请先在火山方舟连接中配置 AK/SK'); return; }
    setBusy(true); if (!preserveNotice) setMessage('');
    try {
      const [groupResult, assetResult] = await Promise.all([
        listAssetGroups(options, { pageNumber: groupPage, pageSize: PAGE_SIZE }),
        listAssets(options, selectedGroup || undefined, query.trim() || undefined, assetPage, PAGE_SIZE),
      ]);
      setGroups(groupResult.items); setGroupTotal(groupResult.totalCount ?? groupResult.items.length);
      setAssets(assetResult.items); setAssetTotal(assetResult.totalCount ?? assetResult.items.length);
      if (!preserveNotice) setMessage('已同步 {groups} 个素材组、{assets} 个素材', { groups: groupResult.totalCount ?? groupResult.items.length, assets: assetResult.totalCount ?? assetResult.items.length });
    } catch (error) { setMessage(error instanceof Error ? error.message : '同步失败'); }
    finally { setBusy(false); }
  }, [accessKeyId, secretAccessKey, options, selectedGroup, query, groupPage, assetPage, setMessage]);
  useEffect(() => { let cancelled = false; void Promise.all([readAppSecret(accessKeySecretRef), readAppSecret(secretAccessKeySecretRef)]).then(([ak, sk]) => { if (!cancelled) { setAccessKeyId(ak || ''); setSecretAccessKey(sk || ''); setLoadedSecretFingerprint(secretFingerprint); } }); return () => { cancelled = true; }; }, [accessKeySecretRef, secretAccessKeySecretRef, secretFingerprint]);
  useEffect(() => { if (!enabled || !secretsLoaded || !configured) return; const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [enabled, secretsLoaded, configured, load]);
  useLayoutEffect(() => {
    filePickVersion.current += 1;
    uploadAbort.current?.abort();
  }, [providerId]);
  useEffect(() => () => { filePickVersion.current += 1; uploadAbort.current?.abort(); }, []);
  const openDialog = (next: Dialog) => {
    if (busy || pickingFileRef.current || submittingRef.current) return;
    setDialog(next); setDialogError(''); setDeleteConfirmation('');
    if (next?.kind === 'create-group') { setFormName(''); setFormDescription(''); }
    if (next?.kind === 'edit-group') { setFormName(next.group.name); setFormDescription(next.group.description || ''); }
    if (next?.kind === 'create-asset') {
      setFormName(t('未命名素材')); setFormUrl(''); setFormGroupId(selectedGroup);
      setSourceMode('local'); setLocalSource(undefined); setFormAssetType('');
    }
    if (next?.kind === 'edit-asset') setFormName(next.asset.name);
  };
  const closeDialog = () => {
    if (busy || pickingFileRef.current || submittingRef.current) return;
    filePickVersion.current += 1;
    setDialog(null); setLocalSource(undefined); setFormUrl('');
  };
  const pickLocalSource = async () => {
    if (busy || pickingFileRef.current || submittingRef.current) return;
    if (!isTauriEnv()) { setDialogError(t('本地素材上传仅支持 Tauri 桌面端')); return; }
    pickingFileRef.current = true; setPickingFile(true); setDialogError('');
    const version = ++filePickVersion.current;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ multiple: false, directory: false, title: t('选择上传到火山人像库的素材'),
        filters: [{ name: t('图片、视频与音频'), extensions: ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'gif', 'heic', 'heif', 'mp4', 'mov', 'mp3', 'wav'] }] });
      if (!selected || Array.isArray(selected) || version !== filePickVersion.current) return;
      setLocalSource(undefined); setFormAssetType('');
      const assetType = inferAssetType(selected);
      if (!assetType) { setDialogError(t('请选择受支持的图片、MP4/MOV 视频或 MP3/WAV 音频')); return; }
      const fileName = selected.split(/[\\/]/).pop() || t('未命名素材');
      const url = await getAssetUrlFromPath(selected);
      if (version !== filePickVersion.current) return;
      setLocalSource({ url, fileName }); setFormAssetType(assetType);
      setFormName((current) => !current.trim() || current === t('未命名素材') ? fileName.replace(/\.[^.]+$/, '') : current);
    } catch {
      if (version === filePickVersion.current) setDialogError(t('无法选择本地素材，请在桌面端重试'));
    } finally {
      pickingFileRef.current = false;
      setPickingFile(false);
    }
  };
  const run = async (action: () => Promise<unknown>, success: string) => {
    if (submittingRef.current) return;
    const version = filePickVersion.current;
    submittingRef.current = true;
    setBusy(true);
    setDialogError('');
    setMessage('正在提交，请稍候...');
    try {
      await action();
      if (version !== filePickVersion.current) return;
      // 先关闭弹窗，让用户明确看到提交已完成；列表刷新不阻塞弹窗状态。
      setDialog(null);
      setLocalSource(undefined); setFormUrl('');
      setMessage(success);
      void load(true);
    } catch (error) {
      if (version !== filePickVersion.current) return;
      const detail = error instanceof Error ? error.message : '操作失败';
      setDialogError(detail);
      setMessage('提交失败，请检查弹窗中的错误信息');
    } finally {
      submittingRef.current = false; uploadAbort.current = null;
      setBusy(false);
    }
  };
  const submitDialog = async () => {
    if (!dialog || busy || pickingFileRef.current || submittingRef.current) return;
    if (dialog.kind === 'create-group') { if (!formName.trim()) return setDialogError('请输入素材组名称'); return run(() => createAssetGroup(options, { name: formName.trim(), description: formDescription.trim() }), '素材组已创建'); }
    if (dialog.kind === 'edit-group') { if (!formName.trim()) return setDialogError('请输入素材组名称'); return run(() => updateAssetGroup(options, dialog.group.id, { name: formName.trim(), description: formDescription.trim() }), '素材组已更新'); }
    if (dialog.kind === 'create-asset') {
      if (!formGroupId) return setDialogError('请选择素材组');
      if (!providerId || !tosConfigured) return setDialogError('请先在火山方舟连接中配置 TOS Bucket 和 AK/SK');
      const source = sourceMode === 'local' ? localSource?.url : formUrl.trim();
      if (!formName.trim() || !source) return setDialogError('请填写素材名称并选择文件或输入素材 URL');
      if (!formAssetType) return setDialogError('请选择素材类型');
      return run(() => {
        const controller = new AbortController(); uploadAbort.current = controller;
        return createVolcengineAssetViaTos(providerId, { ...options, signal: controller.signal }, {
          assetType: formAssetType, groupId: formGroupId, name: formName.trim(), url: source,
        });
      }, '素材入库任务已提交，正在处理；状态变为可用后才能用于生成');
    }
    if (dialog.kind === 'edit-asset') { if (!formName.trim()) return setDialogError('请输入素材名称'); return run(() => updateAsset(options, dialog.asset.id, { name: formName.trim() }), '素材已更新'); }
    if (dialog.kind === 'delete-asset') return run(() => deleteAsset(options, dialog.asset.id), '素材已删除');
    if (dialog.kind === 'delete-group' && deleteConfirmation.trim() === dialog.group.name.trim()) return run(async () => { await deleteAssetGroup(options, dialog.group.id); setSelectedGroup(''); setAssetPage(1); }, '素材组已删除');
  };
  const inspectAsset = async (item: VolcengineAsset) => { try { const detail = await getAsset(options, item.id); setMessage('素材 {name}：{status}，ID={id}', { name: detail.name, status: detail.status, id: detail.id }); } catch (error) { setMessage(error instanceof Error ? error.message : '查询素材失败'); } };
  const inspectGroup = async () => { if (!selectedGroup) return; try { const detail = await getAssetGroup(options, selectedGroup); setMessage(detail.description ? '素材组 {name}：{description}' : '素材组 {name}：无描述', { name: detail.name, description: detail.description || '' }); } catch (error) { setMessage(error instanceof Error ? error.message : '查询素材组失败'); } };
  const selectedGroupItem = groups.find((item) => item.id === selectedGroup);
  const groupPages = Math.max(1, Math.ceil(groupTotal / PAGE_SIZE));
  const assetPages = Math.max(1, Math.ceil(assetTotal / PAGE_SIZE));
  const showConfigPrompt = !enabled || (secretsLoaded && !configured);
  const showSecretsLoading = !showConfigPrompt && !secretsLoaded;
  const showLibrary = !showConfigPrompt && secretsLoaded;
  useEffect(() => { onCountChange?.(assetTotal); }, [assetTotal, onCountChange]);
  const groupedAssets = useMemo(() => {
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    const result = new Map<string, { name: string; items: VolcengineAsset[] }>();
    assets.forEach((item) => {
      const key = item.groupId || 'unknown';
      const group = groupsById.get(key);
      const current = result.get(key) || { name: group?.name || '', items: [] };
      current.items.push(item); result.set(key, current);
    });
    return [...result.entries()].map(([id, value]) => ({ id, ...value }));
  }, [assets, groups]);
  const pageControls = (page: number, pages: number, setPage: (value: number) => void, label: string) => <div className="mt-2 flex items-center justify-between text-xs text-canvas-text-muted"><span>{t(label)} · {t('第 {page} / {pages} 页', { page, pages })}</span><span className="flex gap-1"><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={page <= 1 || busy} onClick={() => setPage(page - 1)}>{t('上一页')}</button><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={page >= pages || busy} onClick={() => setPage(page + 1)}>{t('下一页')}</button></span></div>;
  return <section className={`flex min-h-0 flex-1 flex-col ${compact ? 'p-2' : 'ui-card mt-3 p-3'}`} aria-label={t('火山方舟虚拟人像库')}>
    <div className="flex items-center gap-2"><Icon icon="mdi:account-box-multiple-outline" width="18" /><strong>{t('火山方舟虚拟人像库')}</strong></div>
    {showConfigPrompt && (
      <div className="mt-3 rounded-lg border border-canvas-border bg-canvas-surface p-4"><div className="flex items-start gap-3"><Icon icon="mdi:cloud-alert-outline" width="22" className="mt-0.5 shrink-0 text-canvas-text-secondary" /><div className="min-w-0"><h3 className="text-sm font-medium text-canvas-text">{t('还没有配置火山方舟虚拟人像库')}</h3><p className="mt-1 text-xs leading-5 text-canvas-text-muted">{t('请在火山方舟编辑连接中填写 AK/SK，并启用虚拟人像库。配置完成后即可在这里查看和管理素材。')}</p><button type="button" className="ui-btn ui-btn--sm ui-btn--primary mt-3" onClick={() => provider ? onOpenProviderSettings?.() : useAppStore.getState().openApiKeySettings()}><Icon icon="mdi:cog-outline" width="15" />{t('前往火山方舟配置')}<Icon icon="mdi:arrow-right" width="15" /></button></div></div></div>
    )}
    {showSecretsLoading && (
      <p className="mt-3 text-xs text-canvas-text-muted">{t('正在读取火山方舟素材库配置...')}</p>
    )}
    {showLibrary && (
      <div className="flex min-h-0 flex-1 flex-col">
      <div className="mt-2 flex flex-wrap gap-2"><Select className="min-w-0 flex-1" value={selectedGroup} onChange={(value) => { setSelectedGroup(value); setAssetPage(1); }} options={[{ value: '', label: t('全部素材组') }, ...groups.map((group) => ({ value: group.id, label: group.name }))]} fixedMenu /><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => openDialog({ kind: 'create-group' })}>{t('新建组')}</button><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={!selectedGroupItem} onClick={() => selectedGroupItem && openDialog({ kind: 'edit-group', group: selectedGroupItem })}>{t('改名')}</button><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={!selectedGroup} onClick={() => void inspectGroup()}>{t('详情')}</button><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={!selectedGroupItem} onClick={() => selectedGroupItem && openDialog({ kind: 'delete-group', group: selectedGroupItem })}>{t('删除组')}</button><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={busy} onClick={() => void load()}><Icon icon="mdi:refresh" /></button></div>
      {pageControls(groupPage, groupPages, setGroupPage, '素材组')}
      <div className="mt-2 flex gap-2"><input className="ui-input min-w-0 flex-1" placeholder={t('按名称搜索素材')} value={query} onChange={(event) => { setQuery(event.target.value); setAssetPage(1); }} /><button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={busy || pickingFile} onClick={() => openDialog({ kind: 'create-asset' })}>{t('上传素材')}</button></div>
      <div className="mt-3 min-h-0 flex-1 space-y-4 overflow-auto">{groupedAssets.map((section) => <section key={section.id} aria-label={t('素材组 {name}', { name: section.name || t('未命名素材组') })}><div className="mb-2 flex items-center gap-2"><Icon icon="mdi:folder-multiple-outline" width="15" /><h3 className="text-xs font-semibold text-canvas-text">{section.name || t('未命名素材组')}</h3><span className="text-[10px] text-canvas-text-muted">{section.items.length}</span></div><div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{section.items.map((item) => {
        const mediaType = item.assetType?.toLowerCase();
        const isImage = mediaType === 'image' || (!mediaType && Boolean(item.thumbnailUrl));
        return <article key={item.id} className="group overflow-hidden rounded border border-canvas-border bg-canvas-surface">
          <button type="button" className="block aspect-video w-full overflow-hidden bg-canvas-bg text-left" onClick={() => void inspectAsset(item)} aria-label={t('查看素材 {name}', { name: item.name })}>
            {isImage && item.thumbnailUrl ? <ViewportImage src={item.thumbnailUrl} alt={item.name} className="h-full w-full object-cover" draggable={false} /> : mediaType === 'video' && item.thumbnailUrl ? <VideoThumbnail src={item.thumbnailUrl} name={item.name} alt="" className="block h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center text-canvas-text-muted"><Icon icon={mediaType === 'audio' ? 'mdi:music-note-outline' : mediaType === 'video' ? 'mdi:video-outline' : 'mdi:image-off-outline'} width="28" /></span>}
          </button>
          <div className="p-2"><div className="flex items-start gap-1"><span className="min-w-0 flex-1 truncate text-xs" title={item.name}>{item.name}</span><span className={item.status === 'Active' ? 'shrink-0 text-[10px] text-emerald-400' : 'shrink-0 text-[10px] text-canvas-text-muted'}>{getVolcengineAssetStatusLabel(item.status)}</span></div><div className="mt-1 flex items-center justify-end gap-1"><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost px-1" onClick={() => openDialog({ kind: 'edit-asset', asset: item })} aria-label={t('编辑素材 {name}', { name: item.name })}><Icon icon="mdi:pencil-outline" width="13" /></button><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost px-1" onClick={() => openDialog({ kind: 'delete-asset', asset: item })} aria-label={t('删除素材 {name}', { name: item.name })}><Icon icon="mdi:delete-outline" width="13" /></button></div></div>
        </article>;
      })}</div></section>)}{!assets.length && <p className="text-xs text-canvas-text-muted">{t('暂无素材')}</p>}</div>
      {pageControls(assetPage, assetPages, setAssetPage, '素材')}
      </div>
    )}
    {message && <p className="mt-2 text-xs text-canvas-text-muted">{message}</p>}
    <ModalOverlay isOpen={Boolean(dialog)} onClose={closeDialog} ariaLabel={t('虚拟人像库操作')} className="w-[min(92vw,30rem)]" closeOnBackdrop={false}>
      {dialog && <div className="flex max-h-[90dvh] flex-col" aria-busy={busy || pickingFile}><div className="flex shrink-0 items-center justify-between border-b border-canvas-border px-2.5 py-2"><div><h2 className="ui-title">{t(dialog.kind === 'create-group' ? '新建素材组' : dialog.kind === 'edit-group' ? '编辑素材组' : dialog.kind === 'create-asset' ? '上传素材' : dialog.kind === 'edit-asset' ? '编辑素材' : dialog.kind === 'delete-group' ? '删除素材组' : '删除素材')}</h2><p className="mt-1 text-xs text-canvas-text-muted">{t(dialog.kind === 'delete-group' ? '删除后组内素材也会一并删除，且无法恢复。' : '请填写完整信息后提交。')}</p></div><PopupCloseButton onClick={closeDialog} ariaLabel={t('关闭')} disabled={busy || pickingFile} /></div><div className="ui-stack min-h-0 overflow-y-auto p-3">
        {(dialog.kind === 'create-group' || dialog.kind === 'edit-group') && <><label className="ui-field"><span className="ui-label">{t('素材组名称')}</span><input className="ui-input" value={formName} onChange={(event) => setFormName(event.target.value)} autoFocus /></label><label className="ui-field"><span className="ui-label">{t('描述（可选）')}</span><textarea className="ui-textarea min-h-20 py-2" value={formDescription} onChange={(event) => setFormDescription(event.target.value)} /></label></>}
        {(dialog.kind === 'create-asset' || dialog.kind === 'edit-asset') && <><label className="ui-field"><span className="ui-label">{t('素材名称')}</span><input className="ui-input" value={formName} onChange={(event) => setFormName(event.target.value)} disabled={busy || pickingFile} autoFocus /></label>{dialog.kind === 'create-asset' && <>
          <label className="ui-field"><span className="ui-label">{t('素材组')}</span><Select className="w-full" value={formGroupId} onChange={(value) => setFormGroupId(value)} options={[{ value: '', label: t('请选择素材组') }, ...groups.map((group) => ({ value: group.id, label: group.name }))]} fixedMenu disabled={busy || pickingFile} /></label>
          <label className="ui-field"><span className="ui-label">{t('素材来源')}</span><Select className="w-full" value={sourceMode} onChange={(value) => {
            const mode = value as 'local' | 'url'; setSourceMode(mode); setDialogError('');
            setFormAssetType(inferAssetType(mode === 'local' ? localSource?.fileName ?? '' : formUrl) ?? '');
          }} options={[{ value: 'local', label: t('选择本地文件') }, { value: 'url', label: t('输入素材 URL') }]} fixedMenu disabled={busy || pickingFile} /></label>
          {sourceMode === 'local' ? <div className="ui-field">
            <span className="ui-label">{t('本地素材')}</span>
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm w-fit" disabled={busy || pickingFile || !tosConfigured} onClick={() => void pickLocalSource()}><Icon icon="mdi:folder-open-outline" width="15" />{t(pickingFile ? '正在选择…' : '选择图片、视频或音频')}</button>
            <small className="ui-hint break-words">{localSource?.fileName || t('尚未选择文件')}</small>
          </div> : <label className="ui-field"><span className="ui-label">{t('素材 URL')}</span><input className="ui-input" type="url" placeholder="https://..." value={formUrl} disabled={busy || pickingFile} onChange={(event) => {
            setFormUrl(event.target.value); setFormAssetType(inferAssetType(event.target.value) ?? ''); setDialogError('');
          }} /></label>}
          <label className="ui-field"><span className="ui-label">{t('素材类型')}</span><Select className="w-full" value={formAssetType} onChange={(value) => setFormAssetType(value as AssetType | '')} options={[
            { value: '', label: t('请选择素材类型') }, { value: 'Image', label: t('图片') }, { value: 'Video', label: t('视频') }, { value: 'Audio', label: t('音频') },
          ]} fixedMenu disabled={busy || pickingFile || sourceMode === 'local'} /></label>
          <p className="ui-hint">{t('本地文件和素材 URL 都会先经当前连接的 TOS 上传，再提交人像库入库。提交后需等待状态变为可用。')}</p>
          {sourceMode === 'url' && <p className="ui-hint">{t('URL 无文件后缀时，请手动选择素材类型。')}</p>}
          {!tosConfigured && <div className="ui-alert ui-alert--warning"><Icon icon="mdi:cloud-alert-outline" width="18" /><div className="ui-stack ui-stack--tight min-w-0"><span>{t('请先在火山方舟连接中配置 TOS Bucket 和 AK/SK')}</span><button type="button" className="ui-btn ui-btn--ghost ui-btn--sm w-fit" disabled={busy || pickingFile} onClick={() => {
            closeDialog(); if (onOpenProviderSettings) onOpenProviderSettings(); else useAppStore.getState().openApiKeySettings();
          }}>{t('前往配置 TOS')}</button></div></div>}
        </>}</>}
        {dialog.kind === 'delete-asset' && <div className="ui-alert ui-alert--warning"><Icon icon="mdi:alert-outline" width="18" /><span>{t('确定删除“{name}”？此操作不可恢复。', { name: dialog.asset.name })}</span></div>}
        {dialog.kind === 'delete-group' && <><div className="ui-alert ui-alert--danger"><Icon icon="mdi:alert-octagon-outline" width="18" /><span>{t('将删除素材组“{name}”及组内全部素材。此操作不可恢复。', { name: dialog.group.name })}</span></div><label className="ui-field"><span className="ui-label">{t('输入素材组名称以确认')}</span><input className="ui-input" value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} placeholder={dialog.group.name} autoFocus /></label></>}
      </div>{busy && <div className="mx-3 mb-3 ui-alert" role="status"><Icon icon="mdi:loading" width="18" className="animate-spin" /><span>{t('正在提交，请不要关闭窗口...')}</span></div>}{dialogError && <div className="mx-3 mb-3 ui-alert ui-alert--danger"><Icon icon="mdi:alert-circle-outline" width="18" /><span className="min-w-0 break-words">{t(dialogError)}</span></div>}<div className="flex shrink-0 justify-end gap-2 border-t border-canvas-border p-3"><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={closeDialog} disabled={busy || pickingFile}>{t('取消')}</button><button type="button" className={`ui-btn ui-btn--sm ${dialog.kind === 'delete-group' || dialog.kind === 'delete-asset' ? 'ui-btn--danger' : 'ui-btn--primary'}`} disabled={busy || pickingFile || dialog.kind === 'create-asset' && !tosConfigured || (dialog.kind === 'delete-group' && deleteConfirmation.trim() !== dialog.group.name.trim())} onClick={() => void submitDialog()}>{t(busy ? '提交中...' : dialog.kind === 'delete-group' || dialog.kind === 'delete-asset' ? '确认删除' : '保存')}</button></div></div>}
    </ModalOverlay>
  </section>;
}
