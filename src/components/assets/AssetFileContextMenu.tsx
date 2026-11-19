/**
 * AssetFileContextMenu — 提供资产文件右键菜单界面与交互。
 */
import { t, useT } from '../../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import ModalOverlay from '../shared/ModalOverlay';
import type { DramaAssetKind } from '../../types/dramaAssets';
import type { AssetUsageTarget } from '../../types/assetUsage';
import AssetUsageDialog from './AssetUsageDialog';

export interface AssetFileContextMenuProps {
  name: string;
  x: number;
  y: number;
  canFileActions: boolean;
  canCopyPrompt: boolean;
  confirmDelete?: boolean;
  onCopy: () => Promise<void>;
  onCopyPrompt: () => Promise<void>;
  onReveal: () => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
  onCreateCreativeAsset?: (kind: DramaAssetKind) => Promise<void>;
  usageTarget?: AssetUsageTarget;
  onRepair?: () => void;
  onPublishShared?: () => Promise<void>;
}

/** 资产文件菜单只管理交互；路径、提示词查询及删除由资产面板编排。 */
export default function AssetFileContextMenu({ name, x, y, canFileActions, canCopyPrompt,
  confirmDelete = false, onCopy, onCopyPrompt, onReveal, onDelete, onClose, onCreateCreativeAsset, usageTarget, onRepair, onPublishShared }: AssetFileContextMenuProps) {
  useT();
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(confirmDelete);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUsage, setShowUsage] = useState(false);
  const pendingRef = useRef(false);
  const mountedRef = useRef(false);
  const close = useCallback(() => { if (!pendingRef.current) onClose(); }, [onClose]);

  useEffect(() => {
    mountedRef.current = true;
    const trigger = document.activeElement as HTMLElement | null;
    return () => { mountedRef.current = false; if (trigger?.isConnected) trigger.focus(); };
  }, []);

  useEffect(() => {
    if (confirming || showUsage) return;
    const menu = menuRef.current;
    const items = () => Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    items()[0]?.focus();
    const outside = (event: PointerEvent) => { if (!menu?.contains(event.target as Node)) close(); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); close();
      } else if (event.key === 'Tab') {
        event.preventDefault(); event.stopImmediatePropagation(); close();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const buttons = items();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    };
    const capture = { capture: true };
    window.addEventListener('pointerdown', outside, capture);
    window.addEventListener('keydown', keyboard, capture);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, capture);
    return () => {
      window.removeEventListener('pointerdown', outside, capture);
      window.removeEventListener('keydown', keyboard, capture);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, capture);
    };
  }, [close, confirming, showUsage]);

  // 同步租约阻止快速连点；确认失败保留对话框，用户可以检查权限后重试。
  const run = async (action: () => Promise<void>, share = false) => {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(true); setError(null);
    try { await action(); if (mountedRef.current) onClose(); }
    catch (cause) {
      if (mountedRef.current) setError(share && (typeof cause === 'string' || cause instanceof Error)
        ? (typeof cause === 'string' ? cause : cause.message)
        : confirming ? '删除失败，文件仍保留。请检查文件是否被占用或权限不足。' : '操作失败，请重试。');
    }
    finally { pendingRef.current = false; if (mountedRef.current) setPending(false); }
  };

  if (usageTarget && (confirming || showUsage)) return <AssetUsageDialog target={usageTarget} onClose={close}
    onConfirmDelete={confirming ? onDelete : undefined} />;
  if (confirming) return <ModalOverlay isOpen onClose={close} ariaLabel={t("移入回收站")} zIndex={360}
    motionPreset="quick" closeOnBackdrop={!pending} className="w-[min(420px,calc(100vw-24px))] p-3 gap-3">
    <h3 className="text-sm font-semibold text-canvas-text">{t("移入系统回收站？")}</h3>
    <p className="text-sm text-canvas-text break-words">{name}</p>
    <p className="text-xs text-canvas-text-secondary leading-relaxed">{t("这会移除磁盘原文件，可能影响画布中的引用。提示词、参考图关联和生成历史将保留，可从系统回收站恢复文件。")}</p>
    {error && <p role="alert" className="ui-alert ui-alert--danger">{t(error)}</p>}
    <div className="flex justify-end gap-2">
      <button type="button" className="ui-btn ui-btn--ghost" disabled={pending} onClick={close}>{t("取消")}</button>
      <button type="button" className="ui-btn ui-btn--danger" disabled={pending} onClick={() => void run(onDelete)}>{pending ? t('正在移入…') : t('移入回收站')}</button>
    </div>
  </ModalOverlay>;

  const left = Math.max(8, Math.min(x, (window.innerWidth || 1024) - 216));
  const top = Math.max(8, Math.min(y, (window.innerHeight || 768) - (onCreateCreativeAsset ? 292 : 172) - (onPublishShared ? 32 : 0)));
  return createPortal(<div ref={menuRef} role="menu" aria-label={t('{name}的文件操作', { name })} className="ui-menu w-52"
    style={{ position: 'fixed', left, top, zIndex: 340 }} onContextMenu={(event) => event.preventDefault()}>
    <button type="button" role="menuitem" className="ui-menu__item" disabled={!canFileActions || pending} onClick={() => void run(onCopy)}>
      <Icon icon="lucide:copy" className="w-4 h-4" />{t("复制")}</button>
    <button type="button" role="menuitem" className="ui-menu__item" disabled={!canCopyPrompt || pending} onClick={() => void run(onCopyPrompt)}>
      <Icon icon="lucide:clipboard-copy" className="w-4 h-4" />{t("复制提示词")}</button>
    <button type="button" role="menuitem" className="ui-menu__item" disabled={!canFileActions || pending} onClick={() => void run(onReveal)}>
      <Icon icon="lucide:folder-open" className="w-4 h-4" />{t("打开文件所在目录")}</button>
    {usageTarget && <button type="button" role="menuitem" className="ui-menu__item" disabled={pending} onClick={() => setShowUsage(true)}>
      <Icon icon="lucide:link" className="w-4 h-4" />{t('查看使用位置')}</button>}
    {onRepair && <button type="button" role="menuitem" className="ui-menu__item" disabled={pending} onClick={() => { onRepair(); onClose(); }}>
      <Icon icon="lucide:folder-search" className="w-4 h-4" />{t('重新定位文件')}</button>}
    {onPublishShared && <button type="button" role="menuitem" className="ui-menu__item" disabled={pending} onClick={() => void run(onPublishShared, true)}>
      <Icon icon="lucide:link-2" className="w-4 h-4" aria-hidden="true" />{t('发布到 WSAGENT 共享库')}</button>}
    {onCreateCreativeAsset && <>
      <div className="ui-menu__sep" />
      {([{ kind: 'character', label: t('添加到全局人物'), icon: 'lucide:contact-round' },
        { kind: 'scene', label: t('添加到全局场景'), icon: 'lucide:landmark' },
        { kind: 'prop', label: t('添加到全局道具'), icon: 'lucide:box' }] as const).map((item) => (
        <button key={item.kind} type="button" role="menuitem" className="ui-menu__item" disabled={pending}
          onClick={() => void run(() => onCreateCreativeAsset(item.kind))}>
          <Icon icon={item.icon} className="w-4 h-4" aria-hidden="true" />{t(item.label)}
        </button>
      ))}
    </>}
    <div className="ui-menu__sep" />
    <button type="button" role="menuitem" className="ui-menu__item is-danger" disabled={!canFileActions || pending} onClick={() => setConfirming(true)}>
      <Icon icon="lucide:trash-2" className="w-4 h-4" />{t("删除")}</button>
    {error && <p role="alert" className="px-2 text-xs text-canvas-text-secondary">{t(error)}</p>}
  </div>, document.body);
}
