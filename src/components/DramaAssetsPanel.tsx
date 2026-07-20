/**
 * DramaAssetsPanel — 项目级短剧资产库（人物 / 场景 / 道具）
 * 查看提取结果、确认、删除；数据随项目保存。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import type { DramaAsset, DramaAssetKind } from '../types/dramaAssets';
import { DRAMA_ASSET_KIND_LABEL } from '../types/dramaAssets';

const EASE = [0.22, 1, 0.36, 1] as const;

const KIND_TABS: Array<{ key: DramaAssetKind | 'all'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'character', label: '人物' },
  { key: 'scene', label: '场景' },
  { key: 'prop', label: '道具' },
];

const IMPORTANCE_LABEL: Record<string, string> = {
  main: '主要',
  supporting: '次要',
  minor: '零星',
};

function assetExtraLine(asset: DramaAsset): string {
  if (asset.kind === 'character') {
    const parts = [asset.identity, asset.personality].filter(Boolean);
    return parts.join(' · ');
  }
  if (asset.kind === 'scene') {
    const parts = [asset.placeType, asset.timeOfDay, asset.atmosphere].filter(Boolean);
    return parts.join(' · ');
  }
  const parts = [asset.ownerName, asset.category, asset.significance].filter(Boolean);
  return parts.join(' · ');
}

function DramaAssetCard({
  asset,
  onConfirm,
  onDelete,
}: {
  asset: DramaAsset;
  onConfirm: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-xl border border-canvas-border bg-canvas-bg/60 p-3 hover:border-indigo-500/30 transition-colors">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-semibold text-canvas-text truncate">{asset.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-canvas-hover text-canvas-text-muted shrink-0">
              {DRAMA_ASSET_KIND_LABEL[asset.kind]}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-canvas-hover text-canvas-text-muted shrink-0">
              {IMPORTANCE_LABEL[asset.importance] ?? asset.importance}
            </span>
            {asset.confirmed ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 shrink-0">
                已确认
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 shrink-0">
                待确认
              </span>
            )}
            {asset.imageNodeId || asset.imageUrl ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400 shrink-0">
                已绑图
              </span>
            ) : null}
          </div>
          {asset.summary ? (
            <p className="mt-1 text-[12px] text-canvas-text-secondary leading-relaxed line-clamp-2">
              {asset.summary}
            </p>
          ) : null}
          {asset.visualNotes ? (
            <p className="mt-0.5 text-[11px] text-canvas-text-muted leading-relaxed line-clamp-2">
              外形：{asset.visualNotes}
            </p>
          ) : null}
          {assetExtraLine(asset) ? (
            <p className="mt-0.5 text-[11px] text-canvas-text-muted/80 line-clamp-1">
              {assetExtraLine(asset)}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          {!asset.confirmed && (
            <button
              type="button"
              className="px-2 py-1 rounded-lg text-[11px] font-medium bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors"
              onClick={onConfirm}
            >
              确认
            </button>
          )}
          {asset.confirmed && (
            <button
              type="button"
              className="px-2 py-1 rounded-lg text-[11px] font-medium text-canvas-text-muted hover:bg-canvas-hover transition-colors"
              onClick={onConfirm}
              title="取消确认"
            >
              撤销
            </button>
          )}
          <button
            type="button"
            className="px-2 py-1 rounded-lg text-[11px] font-medium text-red-400/80 hover:bg-red-500/10 transition-colors"
            onClick={onDelete}
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DramaAssetsPanel() {
  const {
    dramaAssetsPanelOpen,
    setDramaAssetsPanelOpen,
    dramaAssets,
    confirmDramaAsset,
    deleteDramaAsset,
    clearDramaAssetsByKind,
  } = useAppStore(
    useShallow((s) => ({
      dramaAssetsPanelOpen: s.dramaAssetsPanelOpen,
      setDramaAssetsPanelOpen: s.setDramaAssetsPanelOpen,
      dramaAssets: s.dramaAssets,
      confirmDramaAsset: s.confirmDramaAsset,
      deleteDramaAsset: s.deleteDramaAsset,
      clearDramaAssetsByKind: s.clearDramaAssetsByKind,
    })),
  );

  const [tab, setTab] = useState<DramaAssetKind | 'all'>('all');
  const [search, setSearch] = useState('');

  const close = useCallback(() => setDramaAssetsPanelOpen(false), [setDramaAssetsPanelOpen]);

  useEffect(() => {
    if (!dramaAssetsPanelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dramaAssetsPanelOpen, close]);

  const totals = useMemo(
    () => ({
      character: dramaAssets.characters.length,
      scene: dramaAssets.scenes.length,
      prop: dramaAssets.props.length,
      all:
        dramaAssets.characters.length +
        dramaAssets.scenes.length +
        dramaAssets.props.length,
    }),
    [dramaAssets],
  );

  const items = useMemo(() => {
    let list: DramaAsset[] = [];
    if (tab === 'all' || tab === 'character') list = list.concat(dramaAssets.characters);
    if (tab === 'all' || tab === 'scene') list = list.concat(dramaAssets.scenes);
    if (tab === 'all' || tab === 'prop') list = list.concat(dramaAssets.props);

    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.summary.toLowerCase().includes(q) ||
          a.visualNotes.toLowerCase().includes(q) ||
          (a.storyRole ?? '').toLowerCase().includes(q),
      );
    }
    // 待确认优先，再按更新时间
    return list.sort((a, b) => {
      if (a.confirmed !== b.confirmed) return a.confirmed ? 1 : -1;
      return b.updatedAt - a.updatedAt;
    });
  }, [dramaAssets, tab, search]);

  const lastExtractLabel = useMemo(() => {
    const le = dramaAssets.lastExtract;
    if (!le) return null;
    const kinds = le.kinds.map((k) => DRAMA_ASSET_KIND_LABEL[k]).join('、');
    const t = new Date(le.at);
    const time = `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    return `最近提取：${kinds} · ${time}`;
  }, [dramaAssets.lastExtract]);

  const handleClearTab = useCallback(() => {
    if (tab === 'all') return;
    const label = DRAMA_ASSET_KIND_LABEL[tab];
    if (!window.confirm(`清空全部「${label}」资产？此操作不可撤销。`)) return;
    clearDramaAssetsByKind(tab);
  }, [tab, clearDramaAssetsByKind]);

  return (
    <AnimatePresence>
      {dramaAssetsPanelOpen && (
        <>
          <motion.div
            className="fixed inset-0 z-[240] bg-black/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={close}
          />

          <motion.div
            className="fixed inset-x-0 bottom-0 z-[250] mx-auto w-full max-w-[720px] max-h-[75vh] flex flex-col
                       glass-panel border border-b-0 rounded-t-2xl shadow-2xl overflow-hidden"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.3, ease: EASE }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-canvas-border shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  className="text-canvas-text-secondary shrink-0"
                >
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  <path d="M8 7h8M8 11h5" />
                </svg>
                <h2 className="text-sm font-semibold text-canvas-text shrink-0">短剧资产</h2>
                <span className="text-[11px] text-canvas-text-muted shrink-0">共 {totals.all} 条</span>
                {lastExtractLabel ? (
                  <span className="text-[10px] text-canvas-text-muted/70 truncate hidden sm:inline">
                    {lastExtractLabel}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                className="w-7 h-7 rounded-lg hover:bg-canvas-hover flex items-center justify-center text-canvas-text-secondary hover:text-canvas-text transition-colors"
                onClick={close}
                aria-label="关闭"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Tabs + search */}
            <div className="flex items-center gap-2 px-3 pt-3 pb-2 shrink-0">
              {KIND_TABS.map(({ key, label }) => {
                const count = key === 'all' ? totals.all : totals[key];
                return (
                  <button
                    key={key}
                    type="button"
                    className={`px-3 py-1 rounded-lg text-[11px] font-medium transition-colors shrink-0 ${
                      tab === key
                        ? 'bg-indigo-500/20 text-indigo-400'
                        : 'text-canvas-text-muted hover:text-canvas-text-secondary hover:bg-canvas-hover'
                    }`}
                    onClick={() => setTab(key)}
                  >
                    {label}
                    {count > 0 ? ` ${count}` : ''}
                  </button>
                );
              })}
              <div className="relative w-[180px] ml-auto shrink-0">
                <svg
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-canvas-text-muted"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索名称、简介..."
                  className="w-full pl-7 pr-2 py-1.5 rounded-lg bg-canvas-bg border border-canvas-border
                             text-[12px] text-canvas-text placeholder:text-canvas-text-muted
                             focus:outline-none focus:border-indigo-500/50 transition-colors"
                />
              </div>
            </div>

            {tab !== 'all' && totals[tab] > 0 ? (
              <div className="flex justify-end px-3 pb-1 shrink-0">
                <button
                  type="button"
                  className="text-[11px] text-canvas-text-muted hover:text-red-400 transition-colors"
                  onClick={handleClearTab}
                >
                  清空本类
                </button>
              </div>
            ) : null}

            {/* List */}
            <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-2">
              {items.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-canvas-text-muted">
                  <svg
                    width="40"
                    height="40"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="mb-3 opacity-40"
                  >
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  </svg>
                  <p className="text-[13px] mb-1">
                    {search ? '无匹配资产' : '暂无短剧资产'}
                  </p>
                  <p className="text-[11px] text-center max-w-[280px] leading-relaxed opacity-80">
                    在文本节点用斜杠命令「提取人物 / 场景 / 道具」运行后，结果会自动写入本项目资产库。
                  </p>
                </div>
              ) : (
                items.map((asset) => (
                  <DramaAssetCard
                    key={asset.id}
                    asset={asset}
                    onConfirm={() =>
                      confirmDramaAsset(asset.kind, asset.id, !asset.confirmed)
                    }
                    onDelete={() => {
                      if (window.confirm(`删除「${asset.name}」？`)) {
                        deleteDramaAsset(asset.kind, asset.id);
                      }
                    }}
                  />
                ))
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
