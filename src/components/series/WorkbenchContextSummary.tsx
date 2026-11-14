/** 工作台概览随当前页签切换，避免把剧本格式诊断套用到其他材料。 */
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import type { ScriptWorkbenchDispatch, ScriptWorkbenchSnapshot, WorkbenchEditorTab } from '../../types/scriptWorkbench';
import { normalizeEpisodeAssetRoster } from '../../types/episodeAssets';

const CONTEXT_LABELS: Record<WorkbenchEditorTab, { title: string; icon: string }> = {
  outline: { title: '大纲助手', icon: 'lucide:list-tree' },
  original: { title: '原文写作', icon: 'lucide:book-open' },
  script: { title: '剧本诊断', icon: 'lucide:scan-search' },
  creative: { title: '创作要点', icon: 'lucide:lightbulb' },
  characters: { title: '角色清单', icon: 'lucide:users-round' },
  scenes: { title: '场景清单', icon: 'lucide:map-pin' },
  props: { title: '道具清单', icon: 'lucide:package' },
  'story-graph': { title: '关系图概览', icon: 'lucide:network' },
};

export default function WorkbenchContextSummary({ snapshot, dispatch }: {
  snapshot: ScriptWorkbenchSnapshot; dispatch: ScriptWorkbenchDispatch;
}) {
  const t = useT();
  const { activeTab, draft, analysis, currentEpisode, originalWriting, storyGraphView, storyGraphFilter } = snapshot;
  const context = CONTEXT_LABELS[activeTab];
  const fields = [draft.creative.task, draft.creative.coreConflict, draft.creative.openingHook,
    draft.creative.reversal, draft.creative.endingHook, draft.creative.beats];
  const filled = fields.filter((value) => value.trim()).length;
  const beats = draft.creative.beats.split('\n').filter((value) => value.trim()).length;
  const roster = normalizeEpisodeAssetRoster(currentEpisode?.episodeAssetRoster);
  const entries = activeTab === 'characters' ? roster.characters : activeTab === 'scenes' ? roster.scenes ?? [] : roster.props;
  const bound = entries.filter((entry) => entry.boundDramaAssetId).length;
  let metrics: Array<[string, string]> = [];
  let hint = '';
  switch (activeTab) {
    case 'outline':
      metrics = [['大纲字数', String(draft.outline.replace(/\s/g, '').length)], ['情节点', String(beats)], ['要点完整度', `${filled}/6`], ['目标时长', `${draft.creative.targetDurationSec || '—'} ${t('秒')}`]];
      hint = draft.outline.trim() ? '围绕人物目标、核心冲突和结尾悬念完善本集结构。' : '先写下本集发生了什么，或使用下方大纲工具开始创作。';
      break;
    case 'original':
      metrics = [['原文字数', originalWriting?.loaded ? String(originalWriting.characterCount) : '—'], ['章节', originalWriting?.loaded ? String(originalWriting.chapterCount) : '—'],
        ['文档状态', t(originalWriting?.saving ? '保存中…' : originalWriting?.isNew ? '待首次保存' : originalWriting?.dirty ? '未保存' : originalWriting?.loaded ? '已加载' : '待读取')], ['续写候选', t(originalWriting?.generating ? '生成中…' : originalWriting?.hasCandidate ? '待采用' : '暂无')]];
      hint = originalWriting?.isNew || !snapshot.series?.hasOriginal
        ? '直接在空白原文中写作，或填写要求让 AI 起笔；首次保存会创建并关联原著文件。'
        : '选择章节直接写作，或选中片段润色；续写候选采用后，点击保存原文写入原著文件。';
      break;
    case 'script':
      metrics = [['正文', `${analysis.metrics.characterCount} ${t('字')}`], ['场景', String(analysis.metrics.sceneCount)],
        ['对白占比', analysis.metrics.dialogueRatio === null ? '—' : `${Math.round(analysis.metrics.dialogueRatio * 100)}%`],
        ['预计时长', analysis.metrics.estimatedDurationSec === null ? '—' : t('约 {count} 秒', { count: analysis.metrics.estimatedDurationSec })]];
      break;
    case 'creative':
      metrics = [['已填要点', `${filled}/6`], ['情节点', String(beats)], ['目标时长', `${draft.creative.targetDurationSec || '—'} ${t('秒')}`], ['来源范围', t(draft.creative.sourceRange.trim() ? '已填写' : '待填写')]];
      hint = '在中间编辑创作目标、冲突、钩子与反转；每项右侧的 AI 按钮可单独完善该要点。';
      break;
    case 'characters':
    case 'scenes':
    case 'props':
      metrics = [['本集条目', String(entries.length)], ['已关联资产', String(bound)], ['未关联', String(entries.length - bound)], ['剧本字数', String(draft.script.replace(/\s/g, '').length)]];
      hint = '在清单中提取、手动新增或从资产库添加条目，核对后再关联正式资产。全剧提取会先展示候选预览。';
      break;
    case 'story-graph':
      metrics = [['全剧节点', String(storyGraphView?.counts.totalNodes ?? 0)], ['全剧关系', String(storyGraphView?.counts.totalEdges ?? 0)],
        ['当前节点', String(storyGraphView?.counts.visibleNodes ?? 0)], ['当前关系', String(storyGraphView?.counts.visibleEdges ?? 0)]];
      hint = '在关系图中维护人物、事件与伏笔，点击详情查看来源；提取结果经预览后再加入关系图。';
      break;
  }
  return <section aria-label={t(context.title)} className="space-y-2">
    <div className="flex items-center gap-2">
      <Icon icon={context.icon} className="h-4 w-4 text-canvas-text-secondary" aria-hidden="true" />
      <h3 className="ui-label" aria-live="polite">{t(context.title)}</h3>
    </div>
    <div className="grid grid-cols-2 gap-2">{metrics.map(([label, value]) => <div key={label} className="ui-card min-w-0 p-2">
      <p className="text-[10px] text-canvas-text-muted">{t(label)}</p>
      <p className="mt-1 break-words text-xs font-semibold text-canvas-text-secondary">{value}</p>
    </div>)}</div>
    {activeTab === 'original' && originalWriting?.fileName && <p className="truncate text-xs text-canvas-text-secondary" title={originalWriting.fileName}>{originalWriting.fileName}</p>}
    {hint && <p className="ui-hint">{t(hint)}</p>}
    {snapshot.contextReady && (activeTab === 'original' || activeTab === 'script') && <p className="ui-hint flex items-start gap-1.5">
      <Icon icon="lucide:network" className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {snapshot.hasSavedStoryGraph ? t('AI 创作将参考已保存的故事关系图。') : t('添加人物、事件或伏笔后，AI 创作可参考故事关系图。')}
    </p>}
    {activeTab === 'script' && <div className="grid gap-2">{analysis.diagnostics.slice(0, 4).map((item) => <div key={item.id} className="ui-card p-2">
      <p className="text-[11px] font-medium text-canvas-text-secondary">{t(item.title)}</p>
      <p className="mt-1 text-[10px] leading-4 text-canvas-text-muted">{t(item.detail)}</p>
    </div>)}{analysis.diagnostics.length === 0 && <p className="ui-hint">{t('暂未发现明显的静态格式问题；人物动机、冲突强度等仍需创作判断。')}</p>}</div>}
    {activeTab === 'story-graph' && <div className="flex flex-wrap gap-2">
      <button type="button" className="ui-btn ui-btn--sm" disabled={!snapshot.contextReady || !currentEpisode}
        onClick={() => { void dispatch({ type: 'story_graph_filter', filter: { ...storyGraphFilter, episodeIds: currentEpisode ? [currentEpisode.id] : [], focusNodeId: undefined } }); }}>{t('查看本集关系')}</button>
      <button type="button" className="ui-btn ui-btn--sm" disabled={!snapshot.contextReady}
        onClick={() => { void dispatch({ type: 'story_graph_filter', filter: { ...storyGraphFilter, episodeIds: [], focusNodeId: undefined } }); }}>{t('查看全剧关系')}</button>
    </div>}
  </section>;
}
