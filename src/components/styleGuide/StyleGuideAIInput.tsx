import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import { useReducedMotion } from 'framer-motion';
import ChatComposerEditor, { type ChatComposerEditorHandle, type ChatComposerReference } from '../chat/ChatComposerEditor';
import MentionPicker from '../shared/MentionPicker';
import { ModelMenu, type ModelPickerGroup } from '../shared/ModelPicker';
import ProviderBadge from '../shared/ProviderBadge';
import SendShortcutMenu from '../shared/SendShortcutMenu';
import LazyLoadBoundary from '../shared/LazyLoadBoundary';
import { buildChipEl, buildDramaChipEl, buildSkillChipEl, syncMediaReferenceLabels } from '../nodes/shared/mentionEditorDom';
import { buildReferenceChipEl } from '../shared/referenceChipDom';
import type { PromptSubmitShortcut } from '../../types';
import { getPromptSubmitShortcutHint, PROMPT_SUBMIT_SHORTCUT_OPTIONS } from '../../utils/promptSubmitShortcut';
import { calcAnchoredPosition } from '../../utils/popupPosition';
import referenceImage from '../../assets/images/styles/realistic.webp';
import sceneImage from '../../assets/images/styles/cinematic.webp';

const InputMetalFx = lazy(() => import('../nodes/shared/PolishMetalFx'));
const ThinkingOrb = lazy(() => import('../../vendor/generation-effects/thinking-orbs/src').then((module) => ({ default: module.ThinkingOrb })));
const BorderBeam = lazy(() => import('../../vendor/generation-effects/border-beam/src').then((module) => ({ default: module.BorderBeam })));

interface DemoReference {
  key: string;
  label: string;
  tab: 'nodes' | 'assets' | 'skills';
  icon: string;
  thumbnailUrl?: string;
  reference: ChatComposerReference;
}

const REFERENCES: DemoReference[] = [
  { key: 'image', label: '角色参考图', tab: 'nodes', icon: 'lucide:image', thumbnailUrl: referenceImage, reference: { kind: 'node', id: 'demo-image', label: '角色参考图', displayId: 14 } },
  { key: 'video', label: '运镜参考视频', tab: 'nodes', icon: 'lucide:video', reference: { kind: 'node', id: 'demo-video', label: '运镜参考视频', displayId: 19 } },
  { key: 'script', label: '三镜脚本', tab: 'nodes', icon: 'lucide:file-text', reference: { kind: 'node', id: 'demo-script', label: '三镜脚本', displayId: 13 } },
  { key: 'character', label: '人物 · 月下剑客', tab: 'assets', icon: 'lucide:user', thumbnailUrl: referenceImage, reference: { kind: 'drama', id: 'demo-character', label: '月下剑客' } },
  { key: 'scene', label: '场景 · 湖心码头', tab: 'assets', icon: 'lucide:image', thumbnailUrl: sceneImage, reference: { kind: 'drama', id: 'demo-scene', label: '湖心码头' } },
  { key: 'storyboard', label: '分镜规划', tab: 'skills', icon: 'lucide:clapperboard', reference: { kind: 'skill', id: 'demo-storyboard', label: '分镜规划' } },
  { key: 'polish', label: '提示词润色', tab: 'skills', icon: 'lucide:sparkles', reference: { kind: 'skill', id: 'demo-polish', label: '提示词润色' } },
];
const NODE_DISPLAY_IDS = new Map(REFERENCES.flatMap(({ reference }) => reference.kind === 'node' ? [[reference.id, reference.displayId] as const] : []));
const NODE_META: Parameters<typeof buildChipEl>[2] = new Map([
  ['demo-image', { type: 'ai-image', displayId: 14, thumbnailUrl: referenceImage, mediaReference: { kind: 'image', key: 'demo-image' } }],
  ['demo-video', { type: 'ai-video', displayId: 19, mediaReference: { kind: 'video', key: 'demo-video' } }],
  ['demo-script', { type: 'ai-text', displayId: 13 }],
]);
const NODE_REFERENCE_PRESENTATION = {
  createElement: (reference: ChatComposerReference) => {
    if (reference.kind === 'node') return buildChipEl(reference.id, reference.label, NODE_META);
    if (reference.kind === 'skill') return buildSkillChipEl(reference.id, reference.label);
    if (reference.kind === 'drama') {
      const item = REFERENCES.find((candidate) => candidate.reference.id === reference.id);
      return buildDramaChipEl(reference.id, reference.label, reference.id === 'demo-scene' ? 'scene' : 'character', item?.thumbnailUrl);
    }
    return buildReferenceChipEl(document, { label: reference.label, iconText: 'M' });
  },
  synchronize: (root: HTMLDivElement) => syncMediaReferenceLabels(root, NODE_META),
};
const REFERENCE_TABS = [{ id: 'nodes', label: '示例节点', icon: 'lucide:shapes' }, { id: 'assets', label: '示例资产', icon: 'lucide:library' }];

/** 只处理演示浮层的锚定与收起；选择内容仍复用真实公共组件。 */
function DemoPickerPopover({ anchor, onClose, className = '', onKeyDown, children }: {
  anchor: HTMLElement;
  onClose: () => void;
  className?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      root.style.width = `${Math.min(380, Math.max(0, window.innerWidth - 16))}px`;
      root.style.maxHeight = `${Math.max(0, Math.min(360, Math.max(rect.top - 12, window.innerHeight - rect.bottom - 12)))}px`;
      const position = calcAnchoredPosition(rect, root.offsetWidth, root.offsetHeight);
      root.style.left = `${position.left}px`;
      root.style.top = `${position.top}px`;
      root.style.zIndex = '10000';
      root.dataset.placement = position.placement;
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(root);
    window.addEventListener('resize', update);
    document.addEventListener('scroll', update, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', update, true);
    };
  }, [anchor]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
      const target = anchor.matches('button') ? anchor : anchor.querySelector<HTMLElement>('[role="textbox"]');
      target?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [anchor, onClose]);

  return createPortal(<div ref={rootRef} className={`ui-scroll fixed z-[10000] ${className}`} onKeyDown={onKeyDown}
    onBlur={(event) => {
      const next = event.relatedTarget as Node | null;
      if (next && !event.currentTarget.contains(next) && !anchor.contains(next)) onClose();
    }}>
    {children}
  </div>, document.body);
}

/** 所有输入、引用、模型和请求状态均为窗口内的演示数据。 */
export default function StyleGuideAIInput({ theme, modelGroups }: { theme: 'dark' | 'light'; modelGroups: ModelPickerGroup[] }) {
  const [value, setValue] = useState('');
  const [model, setModel] = useState('demo-seedance');
  const [expandedGroups, setExpandedGroups] = useState<readonly string[]>(['volcengine']);
  const [picker, setPicker] = useState<{ kind: 'models' | 'references' | 'skills'; anchor: HTMLElement } | null>(null);
  const [tab, setTab] = useState('nodes');
  const [triggerQuery, setTriggerQuery] = useState('');
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [request, setRequest] = useState<{ phase: 'idle' | 'loading' | 'success'; message: string }>({ phase: 'idle', message: '' });
  const [submitShortcut, setSubmitShortcut] = useState<PromptSubmitShortcut>('enter');
  const [shortcutMenuAnchor, setShortcutMenuAnchor] = useState<HTMLElement | null>(null);
  const editorRef = useRef<ChatComposerEditorHandle>(null);
  const editorWrapRef = useRef<HTMLDivElement>(null);
  const requestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listId = useId();
  const reduceMotion = useReducedMotion();
  const running = request.phase === 'loading';
  const currentGroup = modelGroups.find((group) => group.items.some((item) => item.value === model));
  const currentModel = currentGroup?.items.find((item) => item.value === model);
  const shortcutLabel = PROMPT_SUBMIT_SHORTCUT_OPTIONS.find((option) => option.value === submitShortcut)?.label;
  const closePicker = useCallback(() => setPicker(null), []);
  const closeShortcutMenu = useCallback(() => setShortcutMenuAnchor(null), []);

  useEffect(() => () => { if (requestTimer.current !== null) clearTimeout(requestTimer.current); }, []);

  const openReferences = useCallback((kind: 'references' | 'skills', query: string | null) => {
    if (query === null) { setPicker((current) => current?.kind === kind ? null : current); return; }
    if (!editorWrapRef.current) return;
    setTriggerQuery(query);
    setSearch('');
    setSearchExpanded(false);
    setActiveKey(null);
    setShortcutMenuAnchor(null);
    setPicker({ kind, anchor: editorWrapRef.current });
  }, []);
  const onMentionQueryChange = useCallback((query: string | null) => openReferences('references', query), [openReferences]);
  const onSlashQueryChange = useCallback((query: string | null) => openReferences('skills', query), [openReferences]);
  const query = (searchExpanded ? search : triggerQuery).trim().toLocaleLowerCase();
  const candidates = REFERENCES.filter((item) => (picker?.kind === 'skills' ? item.tab === 'skills' : item.tab !== 'skills' && (searchExpanded || item.tab === tab))
    && `${item.label} ${item.reference.kind === 'node' ? item.reference.displayId : ''}`.toLocaleLowerCase().includes(query));
  const activeItem = candidates.find((item) => item.key === activeKey) ?? candidates[0];
  const selectReference = (item: DemoReference) => {
    editorRef.current?.insertReference(item.reference);
    closePicker();
  };
  const handleSuggestionKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!picker || picker.kind === 'models' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
    const target = event.target as HTMLElement;
    if (event.key === 'Tab') {
      if (editorWrapRef.current?.contains(target)) closePicker();
      return false;
    }
    if (picker.kind === 'references' && target.getAttribute('role') === 'textbox' && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      setTab(tab === 'nodes' ? 'assets' : 'nodes');
      setActiveKey(null);
      return true;
    }
    const tabButton = target.closest<HTMLButtonElement>('[role="tab"]');
    if (tabButton) {
      if (!['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return false;
      event.preventDefault();
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
      const index = buttons.indexOf(tabButton);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : event.key === 'ArrowLeft' ? (index - 1 + buttons.length) % buttons.length
          : event.key === 'ArrowRight' ? (index + 1) % buttons.length : index;
      setTab(REFERENCE_TABS[next]?.id ?? 'nodes');
      setActiveKey(null);
      buttons[next]?.focus();
      return true;
    }
    const option = target.closest<HTMLElement>('[role="option"]');
    if (target.closest('button') && !option) return false;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (candidates.length === 0) return true;
      const index = candidates.findIndex((item) => option ? `${listId}-${item.key}` === option.id : item.key === activeItem?.key);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? candidates.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + candidates.length) % candidates.length;
      setActiveKey(candidates[next]?.key ?? null);
      if (option) document.getElementById(`${listId}-${candidates[next]?.key}`)?.focus();
      return true;
    }
    if ((event.key === 'Enter' || (event.key === ' ' && option)) && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      const selected = option ? candidates.find((item) => `${listId}-${item.key}` === option.id) : activeItem;
      if (selected) selectReference(selected);
      return true;
    }
    return false;
  };

  const submit = () => {
    if (!value.trim() || !currentModel || running || requestTimer.current !== null) return;
    closePicker();
    closeShortcutMenu();
    setRequest({ phase: 'loading', message: `正在使用 ${currentModel.label} 模拟生成…` });
    requestTimer.current = setTimeout(() => {
      requestTimer.current = null;
      setRequest({ phase: 'success', message: `${currentModel.label} · 演示完成，已根据提示词与引用生成镜头描述。` });
    }, 2400);
  };
  const sendDisabled = running || !value.trim();
  const generatingFallback = reduceMotion
    ? <Icon icon="lucide:hourglass" width={16} aria-hidden="true" />
    : <span className="ui-spinner" role="img" aria-label="生成中" />;
  const sendButton = <button type="button"
    className={`ui-ai-input__icon-btn ui-ai-input__submit prompt-btn prompt-submit-btn${running ? ' is-generating' : ''}${sendDisabled ? ' disabled' : ''}`}
    disabled={sendDisabled} aria-label={running ? '生成中' : '调用模型生成'} onClick={submit}
    aria-haspopup="menu" aria-expanded={!!shortcutMenuAnchor} title={`${running ? '生成中' : '调用模型生成'} · 右键设置发送快捷键 · ${shortcutLabel}`}>
    {running ? (reduceMotion ? generatingFallback : <LazyLoadBoundary label="生成按钮动画" errorFallback={generatingFallback}>
      <Suspense fallback={generatingFallback}><ThinkingOrb state="composing" size={20} aria-label="生成中" /></Suspense>
    </LazyLoadBoundary>) : <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
    </svg>}
  </button>;

  return <div className="ui-stack max-w-lg">
    <div className="ui-ai-input" aria-busy={running}>
      {running && !reduceMotion && <div className="pointer-events-none absolute -inset-px z-[5]" aria-hidden="true">
        <LazyLoadBoundary label="生成边框特效" errorFallback={null}>
          <Suspense fallback={null}>
            <BorderBeam className="h-full w-full" borderRadius={14} colorVariant="colorful" duration={5} strength={0.85} theme={theme}>{null}</BorderBeam>
          </Suspense>
        </LazyLoadBoundary>
      </div>}
      <div ref={editorWrapRef} className="ui-ai-input__body">
        <ChatComposerEditor ref={editorRef} value={value} onChange={setValue} onSubmit={submit} referencePresentation={NODE_REFERENCE_PRESENTATION}
          submitShortcut={submitShortcut} nodeDisplayIds={NODE_DISPLAY_IDS} onMentionQueryChange={onMentionQueryChange}
          onSlashQueryChange={onSlashQueryChange} onSuggestionKeyDown={handleSuggestionKeyDown}
          suggestionsOpen={!!picker && picker.kind !== 'models'} suggestionListId={listId}
          activeSuggestionId={activeItem ? `${listId}-${activeItem.key}` : undefined}
          placeholder={`输入提示词，@ 引用素材，/ 选择示例 Skill\n${getPromptSubmitShortcutHint(submitShortcut)}`} />
      </div>
      <div className="ui-ai-input__footer ui-ai-input__footer--single-row">
        <div className="model-selector model-selector--pill">
          <button type="button" className="model-selector-trigger prompt-btn text-xs" disabled={running} aria-label="选择演示模型"
            title={currentModel?.label} aria-haspopup="menu" aria-expanded={picker?.kind === 'models'}
            onClick={(event) => { closeShortcutMenu(); setPicker(picker?.kind === 'models' ? null : { kind: 'models', anchor: event.currentTarget }); }}>
            <span className="ui-model-pill__avatar"><ProviderBadge providerId={currentGroup?.id ?? 'apimart'} appearance="metal" theme={theme} /></span>
            <span className="ui-model-pill__label">{currentModel?.label ?? '选择模型'}</span>
            <span className="ui-model-pill__action"><Icon icon="lucide:chevron-down" width={12} aria-hidden="true" /></span>
          </button>
        </div>
        <div className="ui-ai-input__tools">
          <button type="button" className="ui-ai-input__icon-btn" aria-label="选择示例引用素材" aria-expanded={picker?.kind === 'references'} aria-haspopup="listbox" disabled={running}
            onMouseDown={(event) => event.preventDefault()} onClick={() => { openReferences('references', ''); editorRef.current?.focus(); }}>@</button>
          <button type="button" className="ui-ai-input__icon-btn" aria-label="选择示例 Skill" aria-expanded={picker?.kind === 'skills'} aria-haspopup="listbox" disabled={running}
            onMouseDown={(event) => event.preventDefault()} onClick={() => { openReferences('skills', ''); editorRef.current?.focus(); }}>/</button>
          {value.trim() && !running && <span className="ui-ai-input__shortcut-hint text-[11px] text-canvas-text-muted">{shortcutLabel}</span>}
          <div className="prompt-submit-wrap" onContextMenu={(event) => {
            event.preventDefault(); event.stopPropagation(); closePicker(); setShortcutMenuAnchor(event.currentTarget);
          }}>
            {reduceMotion ? sendButton : <LazyLoadBoundary label="AI 输入框金属样例" errorFallback={sendButton}>
              <Suspense fallback={sendButton}>
                <InputMetalFx className="ui-ai-input__send-metal prompt-send-metal" variant="circle" theme={theme}
                  preset={theme === 'light' ? 'silver' : 'chromatic'} strength={theme === 'light' ? 0.65 : 0.81}
                  paused={sendDisabled} normalizeHostStyles={false} innerShadow>{sendButton}</InputMetalFx>
              </Suspense>
            </LazyLoadBoundary>}
          </div>
        </div>
      </div>
    </div>
    {picker && <DemoPickerPopover anchor={picker.anchor} onClose={closePicker}
      className={picker.kind === 'models' ? 'ui-model-menu__surface' : ''}
      onKeyDown={picker.kind === 'models' ? undefined : handleSuggestionKeyDown}>
      {picker.kind === 'models' ? <ModelMenu groups={modelGroups} value={model} expandedGroupIds={expandedGroups}
        onGroupToggle={(id) => setExpandedGroups((current) => current.includes(id) ? current.filter((key) => key !== id) : [...current, id])}
        onClose={closePicker} onChange={(next) => { setModel(next); closePicker(); editorRef.current?.focus(); }} />
        : <MentionPicker tabs={picker.kind === 'skills' ? [{ id: 'skills', label: '示例 Skill', icon: 'lucide:sparkles' }]
          : REFERENCE_TABS}
          activeTab={picker.kind === 'skills' ? 'skills' : tab} onTabChange={(next) => { setTab(next); setActiveKey(null); }}
          items={candidates.map((item) => ({ ...item, domId: `${listId}-${item.key}`, onSelect: () => selectReference(item) }))}
          listId={listId} activeKey={activeItem?.key} onItemHover={setActiveKey} ariaLabel="AI 输入框示例引用"
          emptyText="没有匹配的示例，试试“角色”或清空搜索。"
          search={{ expanded: searchExpanded, onExpandedChange: setSearchExpanded, value: search, onChange: (next) => { setSearch(next); setActiveKey(null); },
            placeholder: '搜索示例名称或编号', onKeyDown: handleSuggestionKeyDown, onCollapse: () => editorRef.current?.focus() }}
          footer={<span className="ui-hint">{picker.kind === 'references' ? '← → 切换分类 · ' : ''}↑ ↓ 选择 · Enter 插入 · Esc 关闭</span>} />}
    </DemoPickerPopover>}
    {shortcutMenuAnchor && <SendShortcutMenu anchor={shortcutMenuAnchor} value={submitShortcut} disabled={running}
      onChange={setSubmitShortcut} onClose={closeShortcutMenu} />}
    {request.phase !== 'idle' && <p className="ui-hint break-words" role="status" aria-live="polite">{request.message}</p>}
    <p className="ui-hint">演示数据 · 点击模型名称切换，输入 @ 或 /、点击对应按钮选择素材或 Skill。发送后展示节点同款思考球与边框流光，2.4 秒后完成并保留提示词；右键可切换发送快捷键。</p>
  </div>;
}
