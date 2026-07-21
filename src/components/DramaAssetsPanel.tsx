/**
 * DramaAssetsPanel — 项目级短剧资产库（人物 / 场景 / 道具）
 * 仅管理：查看 / 编辑 / 删除 / 绑图。
 * 生图在画布图像节点完成：@ 资产（无图=简介，有图=参考图）+ slash 人设参考等。
 */
import { useCallback, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import type { DramaAsset, DramaAssetKind } from '../types/dramaAssets';
import { DRAMA_ASSET_KIND_LABEL } from '../types/dramaAssets';
import { formatDramaAssetTextBrief } from '../services/dramaAssetPrompt';

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
    return [asset.identity, asset.personality].filter(Boolean).join(' · ');
  }
  if (asset.kind === 'scene') {
    return [asset.placeType, asset.timeOfDay, asset.atmosphere].filter(Boolean).join(' · ');
  }
  return [asset.ownerName, asset.category, asset.significance].filter(Boolean).join(' · ');
}

function resolveThumb(
  asset: DramaAsset,
  nodes: Array<{ id: string; data: Record<string, unknown> }>,
): string | undefined {
  if (asset.imageNodeId) {
    const n = nodes.find((x) => x.id === asset.imageNodeId);
    const url =
      (n?.data?.imageUrl as string | undefined)
      || (n?.data?.thumbnailUrl as string | undefined);
    if (url) return url;
  }
  return asset.imageUrl;
}

function DramaAssetCard({
  asset,
  thumb,
  imageNodes,
  editing,
  onToggleEdit,
  onDelete,
  onSaveFields,
  onBindImage,
  onUnbindImage,
  onCopyBrief,
}: {
  asset: DramaAsset;
  thumb?: string;
  imageNodes: Array<{ id: string; label: string }>;
  editing: boolean;
  onToggleEdit: () => void;
  onDelete: () => void;
  onSaveFields: (patch: { name: string; summary: string; visualNotes: string; storyRole: string }) => void;
  onBindImage: (nodeId: string) => void;
  onUnbindImage: () => void;
  onCopyBrief: () => void;
}) {
  const [name, setName] = useState(asset.name);
  const [summary, setSummary] = useState(asset.summary);
  const [visualNotes, setVisualNotes] = useState(asset.visualNotes);
  const [storyRole, setStoryRole] = useState(asset.storyRole ?? '');
  const [bindOpen, setBindOpen] = useState(false);

  const handleToggleEdit = useCallback(() => {
    if (!editing) {
      setName(asset.name);
      setSummary(asset.summary);
      setVisualNotes(asset.visualNotes);
      setStoryRole(asset.storyRole ?? '');
    }
    onToggleEdit();
  }, [asset, editing, onToggleEdit]);

  return (
    <div
      className="drama-asset-card rounded-xl border border-canvas-border bg-canvas-bg/60 p-3 hover:border-indigo-500/30 transition-colors"
      data-asset-kind={asset.kind}
    >
      <div className="drama-asset-card-layout flex items-start gap-3">
        {/* Thumb */}
        <div className="drama-asset-thumbnail w-20 h-20 rounded-lg overflow-hidden shrink-0 bg-canvas-hover border border-canvas-border flex items-center justify-center">
          {thumb ? (
            <img src={thumb} alt="" className="drama-asset-thumbnail-image w-full h-full object-cover" />
          ) : (
            <span className="drama-asset-thumbnail-placeholder text-[12px] text-canvas-text-muted">
              {DRAMA_ASSET_KIND_LABEL[asset.kind][0]}
            </span>
          )}
        </div>

        <div className="drama-asset-card-body flex-1 min-w-0">
          <div className="drama-asset-meta flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-semibold text-canvas-text truncate">{asset.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-canvas-hover text-canvas-text-muted shrink-0">
              {DRAMA_ASSET_KIND_LABEL[asset.kind]}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-canvas-hover text-canvas-text-muted shrink-0">
              {IMPORTANCE_LABEL[asset.importance] ?? asset.importance}
            </span>
            {asset.imageNodeId || asset.imageUrl ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400 shrink-0">
                已绑图
              </span>
            ) : null}
          </div>

          {!editing && (
            <>
              {asset.summary ? (
                <p className="drama-asset-summary mt-1 text-[12px] text-canvas-text-secondary leading-relaxed line-clamp-2">
                  {asset.summary}
                </p>
              ) : null}
              {asset.visualNotes ? (
                <p className="drama-asset-visual-notes mt-0.5 text-[11px] text-canvas-text-muted leading-relaxed line-clamp-2">
                  外形：{asset.visualNotes}
                </p>
              ) : null}
              {assetExtraLine(asset) ? (
                <p className="drama-asset-extra mt-0.5 text-[11px] text-canvas-text-muted/80 line-clamp-1">
                  {assetExtraLine(asset)}
                </p>
              ) : null}
            </>
          )}

          {editing && (
            <div className="drama-asset-editor mt-2 space-y-1.5">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="名称"
                className="w-full px-2 py-1 rounded-lg bg-canvas-bg border border-canvas-border text-[12px] text-canvas-text focus:outline-none focus:border-indigo-500/50"
              />
              <textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="简介"
                rows={2}
                className="w-full px-2 py-1 rounded-lg bg-canvas-bg border border-canvas-border text-[12px] text-canvas-text focus:outline-none focus:border-indigo-500/50 resize-none"
              />
              <textarea
                value={visualNotes}
                onChange={(e) => setVisualNotes(e.target.value)}
                placeholder="外形/视觉要点"
                rows={2}
                className="w-full px-2 py-1 rounded-lg bg-canvas-bg border border-canvas-border text-[12px] text-canvas-text focus:outline-none focus:border-indigo-500/50 resize-none"
              />
              <input
                value={storyRole}
                onChange={(e) => setStoryRole(e.target.value)}
                placeholder="剧情功能（可选）"
                className="w-full px-2 py-1 rounded-lg bg-canvas-bg border border-canvas-border text-[12px] text-canvas-text focus:outline-none focus:border-indigo-500/50"
              />
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30"
                  onClick={() =>
                    onSaveFields({
                      name: name.trim() || asset.name,
                      summary: summary.trim(),
                      visualNotes: visualNotes.trim(),
                      storyRole: storyRole.trim(),
                    })
                  }
                >
                  保存
                </button>
                <button
                  type="button"
                  className="px-2.5 py-1 rounded-lg text-[11px] text-canvas-text-muted hover:bg-canvas-hover"
                  onClick={onToggleEdit}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* Bind image picker */}
          {bindOpen && (
            <div className="drama-asset-bind-picker mt-2 p-2 rounded-lg border border-canvas-border bg-canvas-surface/80 max-h-32 overflow-y-auto space-y-1">
              {imageNodes.length === 0 ? (
                <p className="text-[11px] text-canvas-text-muted px-1">画布上暂无图像节点</p>
              ) : (
                imageNodes.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className="w-full text-left px-2 py-1 rounded text-[11px] text-canvas-text hover:bg-canvas-hover truncate"
                    onClick={() => {
                      onBindImage(n.id);
                      setBindOpen(false);
                    }}
                  >
                    {n.label}
                  </button>
                ))
              )}
              <button
                type="button"
                className="text-[11px] text-canvas-text-muted hover:text-canvas-text px-1"
                onClick={() => setBindOpen(false)}
              >
                关闭
              </button>
            </div>
          )}
        </div>

        {/* Actions — 仅管理，生图请在画布图像节点 @ + slash */}
        <div className="drama-asset-actions flex flex-col gap-1 shrink-0 items-stretch min-w-[72px]">
          <button
            type="button"
            className="drama-asset-action-copy px-2 py-1 rounded-lg text-[11px] text-canvas-text-muted hover:bg-canvas-hover transition-colors"
            onClick={onCopyBrief}
            title="复制本条简介（可粘到图像节点 prompt）"
          >
            复制简介
          </button>
          <button
            type="button"
            className="drama-asset-action-edit px-2 py-1 rounded-lg text-[11px] text-canvas-text-muted hover:bg-canvas-hover transition-colors"
            onClick={handleToggleEdit}
          >
            {editing ? '收起' : '编辑'}
          </button>
          {asset.imageNodeId ? (
            <button
              type="button"
              className="drama-asset-action-unbind px-2 py-1 rounded-lg text-[11px] text-canvas-text-muted hover:bg-canvas-hover transition-colors"
              onClick={onUnbindImage}
            >
              解绑图
            </button>
          ) : (
            <button
              type="button"
              className="drama-asset-action-bind px-2 py-1 rounded-lg text-[11px] text-canvas-text-muted hover:bg-canvas-hover transition-colors"
              onClick={() => setBindOpen((v) => !v)}
            >
              绑图
            </button>
          )}
          <button
            type="button"
            className="drama-asset-action-delete px-2 py-1 rounded-lg text-[11px] font-medium text-red-400/80 hover:bg-red-500/10 transition-colors"
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
    dramaAssets,
    nodes,
    deleteDramaAsset,
    updateDramaAssetFields,
    clearDramaAssetsByKind,
    bindDramaAssetImage,
    unbindDramaAssetImage,
    showToast,
  } = useAppStore(
    useShallow((s) => ({
      dramaAssets: s.dramaAssets,
      nodes: s.nodes,
      deleteDramaAsset: s.deleteDramaAsset,
      updateDramaAssetFields: s.updateDramaAssetFields,
      clearDramaAssetsByKind: s.clearDramaAssetsByKind,
      bindDramaAssetImage: s.bindDramaAssetImage,
      unbindDramaAssetImage: s.unbindDramaAssetImage,
      showToast: s.showToast,
    })),
  );

  const [tab, setTab] = useState<DramaAssetKind | 'all'>('all');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const imageNodes = useMemo(
    () =>
      nodes
        .filter((n) => {
          const t = n.data?.type as string;
          return (
            t === 'ai-image'
            || t === 'source-image'
            || t === 'ai-panorama'
            || t === 'ai-storyboard'
          );
        })
        .map((n) => ({
          id: n.id,
          label: `${(n.data?.label as string) || '图像'} #${n.data?.displayId ?? ''}`,
        })),
    [nodes],
  );

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
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
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

  const copyBrief = useCallback(
    async (asset: DramaAsset) => {
      const text = formatDramaAssetTextBrief(asset);
      try {
        await navigator.clipboard.writeText(text);
        showToast('简介已复制');
      } catch {
        showToast('复制失败', 'error');
      }
    },
    [showToast],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
              {lastExtractLabel ? (
                <span className="ml-1 hidden min-w-0 truncate text-[10px] text-canvas-text-muted/70 md:block">
                  {lastExtractLabel}
                </span>
              ) : null}
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
                  <div className="text-[11px] text-center max-w-[340px] leading-relaxed opacity-90 space-y-1.5">
                    <p className="font-medium text-canvas-text-secondary">本面板只管理简介与绑图</p>
                    <p>1. 文本节点 <code className="px-1 rounded bg-canvas-hover">/</code> → 提取人物/场景/道具</p>
                    <p>2. 图像节点 prompt 里 <code className="px-1 rounded bg-canvas-hover">@</code> 选资产（无图=简介）</p>
                    <p>3. 再 <code className="px-1 rounded bg-canvas-hover">/</code> 人设参考等生成资产图</p>
                    <p>4. 生成后可在此「绑图」，之后 @ 即为参考图</p>
                  </div>
                </div>
              ) : (
                items.map((asset) => (
                  <DramaAssetCard
                    key={asset.id}
                    asset={asset}
                    thumb={resolveThumb(asset, nodes as Array<{ id: string; data: Record<string, unknown> }>)}
                    imageNodes={imageNodes}
                    editing={editingId === asset.id}
                    onToggleEdit={() =>
                      setEditingId((cur) => (cur === asset.id ? null : asset.id))
                    }
                    onDelete={() => {
                      if (window.confirm(`删除「${asset.name}」？`)) {
                        deleteDramaAsset(asset.kind, asset.id);
                      }
                    }}
                    onSaveFields={(patch) => {
                      updateDramaAssetFields(asset.kind, asset.id, {
                        name: patch.name,
                        summary: patch.summary,
                        visualNotes: patch.visualNotes,
                        storyRole: patch.storyRole || undefined,
                      });
                      setEditingId(null);
                      showToast('已保存');
                    }}
                    onBindImage={(nodeId) => {
                      bindDramaAssetImage(asset.kind, asset.id, nodeId);
                      showToast(`已绑定图像节点`);
                    }}
                    onUnbindImage={() => {
                      unbindDramaAssetImage(asset.kind, asset.id);
                      showToast('已解绑');
                    }}
                    onCopyBrief={() => void copyBrief(asset)}
                  />
                ))
              )}
      </div>
    </div>
  );
}
