/**
 * StyleGuideSections — 样式预览窗口的内容区
 *
 * 每个分区展示「外观 + 对应类名」，类名块可点击复制。写新界面时从这里挑控件，
 * 不要另造一套按钮/输入框/卡片；样式定义见 src/styles/ui-kit.css。
 *
 * 文案是面向开发与设计的设计系统术语（类名、变量名保持英文原样），
 * 与 AssetSearchWindow 一样不做逐条 i18n。
 */
import Select from '../shared/Select';
import NumberStepper from '../shared/NumberStepper';
import Tabs from '../shared/Tabs';
import PopupCloseButton from '../shared/PopupCloseButton';
import VideoPlayer from '../shared/VideoPlayer';
import Timeline from '../shared/Timeline';
import MarkdownEditor from '../shared/MarkdownEditor';
import FileUploadButton from '../shared/FileUploadButton';
import ProviderBadge from '../shared/ProviderBadge';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import StyleGuideMascot from './StyleGuideMascot';
import StyleGuideGenerationEffects from './StyleGuideGenerationEffects';

/* ── 分区 id 约定 ──────────────────────────────────────────────────────────
   每个 <Section> 的 id 同时是左侧目录的锚点，目录列表在 StyleGuideWindow.tsx
   里维护。两边必须一致，改 id 时记得同步。 */

/* ==========================================================================
   展示原语
   ========================================================================== */
function Section({ id, title, desc, children }: {
  id: string;
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mb-9 scroll-mt-4">
      <h2 className="m-0 mb-1 text-base font-semibold text-canvas-text">{title}</h2>
      {desc ? <p className="m-0 mb-3 text-xs leading-relaxed text-canvas-text-muted">{desc}</p> : null}
      <div className="ui-stack">{children}</div>
    </section>
  );
}

/** 单个样例：上预览、下类名（可一键复制） */
function Demo({ label, code, children }: { label?: string; code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 剪贴板不可用时静默失败，不影响预览 */
    }
  };

  return (
    // 不裁剪内容：下拉菜单一类的浮层需要溢出到卡片外，圆角交给首尾两块自己补
    <div className="rounded-lg border border-canvas-border bg-canvas-card">
      {label ? (
        <div className="rounded-t-lg border-b border-canvas-border px-3 py-1.5">
          <span className="text-[11px] font-medium text-canvas-text-secondary">{label}</span>
        </div>
      ) : null}
      <div className="p-3">{children}</div>
      <button
        type="button"
        onClick={handleCopy}
        title="点击复制类名"
        className="group flex w-full items-center gap-2 rounded-b-lg border-t border-canvas-border bg-canvas-surface px-3 py-1.5 text-left transition-colors hover:bg-canvas-hover"
      >
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-canvas-text-secondary">
          {code}
        </code>
        <span className="shrink-0 text-[10px] text-canvas-text-muted group-hover:text-canvas-text-secondary">
          {copied ? '已复制' : '复制'}
        </span>
      </button>
    </div>
  );
}

/** 色板：直接读 CSS 变量，展示的是当前主题下的真实色值 */
function Swatch({ cssVar, usage }: { cssVar: string; usage: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className="h-8 w-8 shrink-0 rounded-md border border-canvas-border"
        style={{ background: `var(${cssVar})` }}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <code className="ui-code">{cssVar}</code>
        <p className="m-0 mt-0.5 text-[10px] leading-tight text-canvas-text-muted">{usage}</p>
      </div>
    </div>
  );
}

function SwatchGrid({ items }: { items: { cssVar: string; usage: string }[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-x-4 gap-y-3">
      {items.map((item) => <Swatch key={item.cssVar} {...item} />)}
    </div>
  );
}

/* ==========================================================================
   分区内容
   ========================================================================== */
function ColorsSection() {
  return (
    <Section
      id="sg-colors"
      title="颜色令牌"
      desc="全部颜色来自 base.css 的变量。写样式时只引用变量（或 Tailwind 的 canvas-* token），不要写死色值，浅色主题才能自动生效。"
    >
      <Demo code="--theme-bg / --theme-surface / --theme-card / --theme-border / --theme-hover">
        <p className="m-0 mb-2 text-[11px] text-canvas-text-secondary">主题层 · 背景与描边</p>
        <SwatchGrid items={[
          { cssVar: '--theme-bg', usage: '窗口最底层背景' },
          { cssVar: '--theme-surface', usage: '面板、输入框底' },
          { cssVar: '--theme-card', usage: '卡片、列表块' },
          { cssVar: '--theme-border', usage: '常规描边' },
          { cssVar: '--theme-hover', usage: '悬浮态底色' },
        ]} />
      </Demo>

      <Demo code="--theme-text / --theme-text-secondary / --theme-text-muted">
        <p className="m-0 mb-2 text-[11px] text-canvas-text-secondary">文本层级 · 三级就够，不要再加</p>
        <div className="ui-stack ui-stack--tight">
          <p className="m-0 text-sm text-canvas-text">--theme-text 主文本（标题、正文）</p>
          <p className="m-0 text-xs text-canvas-text-secondary">--theme-text-secondary 次级（说明、表单标签）</p>
          <p className="m-0 text-xs text-canvas-text-muted">--theme-text-muted 弱化（时间戳、占位符）</p>
        </div>
      </Demo>

      <Demo code="--brand / --brand-light / --brand-pale / --brand-alpha-*">
        <p className="m-0 mb-2 text-[11px] text-canvas-text-secondary">品牌色 · 主行动、选中态、焦点环</p>
        <SwatchGrid items={[
          { cssVar: '--brand', usage: '主按钮填充' },
          { cssVar: '--brand-light', usage: '浅底上的品牌文字' },
          { cssVar: '--brand-pale', usage: '更浅底上的文字' },
          { cssVar: '--brand-alpha-15', usage: '选中态淡底' },
        ]} />
      </Demo>

      <Demo code="--success / --info / --warning / --danger">
        <p className="m-0 mb-2 text-[11px] text-canvas-text-secondary">语义色 · 状态提示与危险操作</p>
        <div className="ui-row ui-row--loose">
          <span className="ui-badge ui-badge--success"><i className="ui-badge__dot" />成功</span>
          <span className="ui-badge ui-badge--info"><i className="ui-badge__dot" />信息</span>
          <span className="ui-badge ui-badge--warning"><i className="ui-badge__dot" />警告</span>
          <span className="ui-badge ui-badge--danger"><i className="ui-badge__dot" />危险</span>
        </div>
      </Demo>

      <Demo code="--node-text / --node-image / --node-video / --node-audio / --node-panorama">
        <p className="m-0 mb-2 text-[11px] text-canvas-text-secondary">节点类型色 · 文本=indigo、图像=green、视频=blue、音频=orange、全景=cyan</p>
        <SwatchGrid items={[
          { cssVar: '--node-text', usage: '文本节点' },
          { cssVar: '--node-image', usage: '图像节点' },
          { cssVar: '--node-video', usage: '视频节点' },
          { cssVar: '--node-audio', usage: '音频节点' },
          { cssVar: '--node-panorama', usage: '全景节点' },
        ]} />
      </Demo>
    </Section>
  );
}

function TypographySection() {
  return (
    <Section
      id="sg-typography"
      title="排版"
      desc="字号只有 11 / 12 / 14 / 15 / 17 五档，字重只有 400 / 500 / 600。需要更大的数字用 .ui-stat__value。"
    >
      <Demo code="text-[17px] font-semibold / text-[15px] font-semibold / text-[14px] font-medium">
        <div className="ui-stack ui-stack--tight">
          <p className="m-0 text-[17px] font-semibold text-canvas-text">窗口标题 17 / 600</p>
          <p className="m-0 text-[15px] font-semibold text-canvas-text">面板标题 15 / 600（.ui-title）</p>
          <p className="m-0 text-[14px] font-medium text-canvas-text">分区标题 14 / 500</p>
          <p className="m-0 text-xs text-canvas-text-secondary">正文与控件文字 12 / 400</p>
          <p className="m-0 text-[11px] text-canvas-text-muted">辅助说明与标签 11 / 400</p>
        </div>
      </Demo>

      <Demo code=".ui-code / .ui-kbd / .ui-subtitle">
        <div className="ui-row ui-row--loose ui-row--baseline">
          <span className="text-xs text-canvas-text-secondary">
            内联代码 <code className="ui-code">ui-btn--primary</code>
          </span>
          <span className="text-xs text-canvas-text-secondary">
            快捷键 <kbd className="ui-kbd">Ctrl</kbd> <kbd className="ui-kbd">K</kbd>
          </span>
          <span className="ui-subtitle">小标题 uppercase</span>
        </div>
      </Demo>
    </Section>
  );
}

function ButtonsSection({ theme }: { theme: 'dark' | 'light' }) {
  return (
    <Section
      id="sg-buttons"
      title="按钮"
      desc="基础按钮带淡底与淡描边，与工作流面板一致；primary 一个界面只放一个，ghost 用于工具栏，danger 只给不可逆操作。节点主题色按钮让分类切换与节点类型对应。"
    >
      <Demo label="变体" code="ui-btn ui-btn--primary | --secondary | --ghost | --danger | --link">
        <div className="ui-row">
          <button type="button" className="ui-btn ui-btn--primary">主行动</button>
          <button type="button" className="ui-btn ui-btn--secondary">次级</button>
          <button type="button" className="ui-btn ui-btn--ghost">幽灵</button>
          <button type="button" className="ui-btn ui-btn--danger">删除</button>
          <button type="button" className="ui-btn ui-btn--link">了解更多</button>
        </div>
      </Demo>

      <Demo label="提示词栏共用按钮 · 28px 高度与 14px 金属厂商文字" code="prompt-btn / model-selector--pill > model-selector-trigger prompt-btn + ui-model-pill__avatar（ProviderBadge appearance=metal）+ ui-model-pill__label + ui-model-pill__action">
        <div className="ui-row">
          {['Seedance 2.0', '超长模型名称 · 视频生成预览版本'].map((label) => (
            <div key={label} className="model-selector model-selector--pill w-48">
              <button type="button" className="model-selector-trigger prompt-btn text-xs" title={label}>
                <span className="ui-model-pill__avatar"><ProviderBadge providerId="apimart" size="medium" appearance="metal" theme={theme} /></span>
                <span className="ui-model-pill__label">{label}</span>
                <span className="ui-model-pill__action" aria-hidden="true">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="m6 6 12 12M18 6 6 18" />
                  </svg>
                </span>
              </button>
            </div>
          ))}
          <button type="button" className="prompt-btn" aria-label="画风按钮样例">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M12 3C9 7 5 10.5 5 15a7 7 0 0 0 14 0c0-4.5-4-8-7-12Z" />
            </svg>
          </button>
        </div>
      </Demo>

      <Demo label="节点主题色按钮" code="ui-btn--node-text | --node-image | --node-video | --node-audio | --node-panorama（配合 .is-active）">
        <div className="ui-row">
          {[
            { key: 'text', label: '文本' },
            { key: 'image', label: '图像' },
            { key: 'video', label: '视频' },
            { key: 'audio', label: '音频' },
            { key: 'panorama', label: '全景' },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              className={`ui-btn ui-btn--node-${item.key} is-active`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </Demo>

      <Demo label="尺寸" code="ui-btn--sm（工具栏）/ 默认 / ui-btn--lg（弹窗主行动）">
        <div className="ui-row ui-row--baseline">
          <button type="button" className="ui-btn ui-btn--primary ui-btn--sm">小号</button>
          <button type="button" className="ui-btn ui-btn--primary">默认</button>
          <button type="button" className="ui-btn ui-btn--primary ui-btn--lg">大号</button>
        </div>
      </Demo>

      <Demo label="状态" code=":disabled / .is-active / .is-loading（内部放 .ui-spinner）">
        <div className="ui-row">
          <button type="button" className="ui-btn ui-btn--secondary" disabled>禁用</button>
          <button type="button" className="ui-btn ui-btn--secondary is-active">选中</button>
          <button type="button" className="ui-btn ui-btn--primary is-loading">
            <span className="ui-spinner" />处理中
          </button>
          <button type="button" className="ui-btn ui-btn--primary ui-btn--block">通栏 ui-btn--block</button>
        </div>
      </Demo>

      <Demo label="图标按钮与按钮组" code="ui-icon-btn / ui-icon-btn--danger / ui-btn-group">
        <div className="ui-row ui-row--loose">
          <button type="button" className="ui-icon-btn" aria-label="设置">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button type="button" className="ui-icon-btn ui-icon-btn--danger" aria-label="删除">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <div className="ui-btn-group">
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm">日</button>
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm is-active">周</button>
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm">月</button>
          </div>
        </div>
      </Demo>

      <Demo label="关闭按钮 (统一规范)" code="ui-close-btn anim-btn 或直接复用 <PopupCloseButton />">
        <div className="ui-row ui-row--loose" style={{ alignItems: 'center' }}>
          <PopupCloseButton ariaLabel="关闭样例" />
          <span className="text-xs text-canvas-text-muted">标准弹窗/浮层关闭按钮（悬浮危险色+微缩放动效，透明底主题自适应）</span>
        </div>
      </Demo>
    </Section>
  );
}

function ChipsSection() {
  const [active, setActive] = useState('all');
  const filters = [
    { key: 'all', label: '全部' },
    { key: 'text', label: '文本' },
    { key: 'image', label: '图像' },
    { key: 'video', label: '视频' },
    { key: 'audio', label: '音频' },
  ];

  return (
    <Section
      id="sg-chips"
      title="分类胶囊"
      desc="工作流面板里「生成文本 / 生成图像」那种紧凑分类按钮。用 ui-chip 做默认品牌色，ui-chip--node-* 做节点主题色分类。"
    >
      <Demo label="基础分类" code="ui-chip（.is-active 默认品牌色）">
        <div className="ui-row">
          {filters.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`ui-chip${active === item.key ? ' is-active' : ''}`}
              onClick={() => setActive(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </Demo>

      <Demo label="节点主题色分类" code="ui-chip ui-chip--node-text | --node-image | --node-video | --node-audio | --node-panorama">
        <div className="ui-row">
          {[
            { key: 'text', label: '文本' },
            { key: 'image', label: '图像' },
            { key: 'video', label: '视频' },
            { key: 'audio', label: '音频' },
            { key: 'panorama', label: '全景' },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              className={`ui-chip ui-chip--node-${item.key} is-active`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </Demo>
    </Section>
  );
}

function InputsSection() {
  return (
    <Section
      id="sg-inputs"
      title="输入框"
      desc="统一用 .ui-field 包一层（label + 控件 + hint），间距和错误提示就不用各写一遍了。"
    >
      <Demo label="基础与尺寸" code="<div className=&quot;ui-field&quot;><label className=&quot;ui-label&quot;/><input className=&quot;ui-input&quot;/></div>">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="ui-field">
            <label className="ui-label" htmlFor="sg-input-sm">小号 ui-input--sm</label>
            <input id="sg-input-sm" className="ui-input ui-input--sm" placeholder="请输入" />
          </div>
          <div className="ui-field">
            <label className="ui-label" htmlFor="sg-input-md">默认 ui-input</label>
            <input id="sg-input-md" className="ui-input" placeholder="请输入" />
          </div>
          <div className="ui-field">
            <label className="ui-label" htmlFor="sg-input-lg">大号 ui-input--lg</label>
            <input id="sg-input-lg" className="ui-input ui-input--lg" placeholder="请输入" />
          </div>
        </div>
      </Demo>

      <Demo label="说明与错误态" code=".ui-hint 说明文字 / .ui-error 校验失败 / .ui-input.is-invalid">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="ui-field">
            <label className="ui-label" htmlFor="sg-input-hint">连接名称</label>
            <input id="sg-input-hint" className="ui-input" defaultValue="OpenAI 主账号" />
            <p className="ui-hint">仅本地保存，用于区分多个厂商连接</p>
          </div>
          <div className="ui-field">
            <label className="ui-label" htmlFor="sg-input-err">接口地址</label>
            <input id="sg-input-err" className="ui-input is-invalid" defaultValue="not-a-url" />
            <p className="ui-error">请填写以 http(s):// 开头的完整地址</p>
          </div>
        </div>
      </Demo>

      <Demo label="前后缀" code="ui-input-group + ui-input-affix--leading | --trailing">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="ui-field">
            <label className="ui-label" htmlFor="sg-input-search">搜索</label>
            <div className="ui-input-group">
              <span className="ui-input-affix ui-input-affix--leading">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </span>
              <input id="sg-input-search" className="ui-input" placeholder="搜索文件名或标签…" />
            </div>
          </div>
          <div className="ui-field">
            <label className="ui-label" htmlFor="sg-input-unit">采样步数</label>
            <div className="ui-input-group">
              <input id="sg-input-unit" className="ui-input" defaultValue="20" />
              <span className="ui-input-affix ui-input-affix--trailing">steps</span>
            </div>
          </div>
        </div>
      </Demo>

      <Demo label="多行文本与禁用" code=".ui-textarea（可纵向拉伸）/ :disabled">
        <div className="ui-field">
          <label className="ui-label" htmlFor="sg-textarea">提示词</label>
          <textarea id="sg-textarea" className="ui-textarea" defaultValue="一只在雨中奔跑的柴犬，电影感光影" />
          <p className="ui-hint">右下角可拖动改变高度</p>
        </div>
        <div className="ui-field">
          <label className="ui-label" htmlFor="sg-input-disabled">只读字段</label>
          <input id="sg-input-disabled" className="ui-input" defaultValue="由系统生成，不可编辑" disabled />
        </div>
      </Demo>

      <Demo
        label="数字微调步进输入框 (Number Stepper)"
        code="<NumberStepper value={val} onChange={setVal} min={0} max={100} unit=&quot;px&quot; size=&quot;sm|md|lg&quot; /> / .ui-stepper"
      >
        <NumberStepperDemo />
      </Demo>
    </Section>
  );
}

/** 数字微调步进输入框展示：包含实时试验台、尺寸与状态矩阵、单位与联动场景 */
function NumberStepperDemo() {
  const [val, setVal] = useState(40);
  const [scrubbing, setScrubbing] = useState(false);
  const [opacity, setOpacity] = useState(85);
  const [angle, setAngle] = useState(90);
  const [duration, setDuration] = useState(350);
  const [scale, setScale] = useState(1.2);

  const clampedSize = Math.max(28, Math.min(val, 96));
  const dynamicRadius = Math.min(val / 3, 20);

  return (
    <div className="ui-stack ui-stack--loose">
      {/* 实时交互试验台 */}
      <div className="rounded-xl border border-canvas-border bg-canvas-surface p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-canvas-border pb-2.5">
          <div className="text-xs font-semibold text-canvas-text">实时交互试验台</div>
          <div className="flex items-center gap-1.5 text-[11px] text-canvas-text-muted">
            <span>快捷操作:</span>
            <kbd className="rounded border border-canvas-border bg-canvas-card px-1 py-0.5 font-mono text-[10px] text-canvas-text-secondary">↑ / ↓ (±1)</kbd>
            <kbd className="rounded border border-canvas-border bg-canvas-card px-1 py-0.5 font-mono text-[10px] text-canvas-text-secondary">Shift + ↑ / ↓ (±10)</kbd>
            <kbd className="rounded border border-canvas-border bg-canvas-card px-1 py-0.5 font-mono text-[10px] text-canvas-text-secondary">左右拖拽</kbd>
            <kbd className="rounded border border-canvas-border bg-canvas-card px-1 py-0.5 font-mono text-[10px] text-canvas-text-secondary">滚轮微调</kbd>
          </div>
        </div>

        {/* 视口预览节点 */}
        <div className="mb-4 flex flex-col items-center justify-center rounded-lg border border-dashed border-canvas-border bg-canvas-card/60 p-6">
          <div
            className="flex items-center justify-center bg-gradient-to-tr from-brand to-indigo-500 font-mono text-xs font-bold text-white shadow-md transition-all duration-150"
            style={{ width: clampedSize, height: clampedSize, borderRadius: dynamicRadius }}
          >
            {val}
          </div>
          <span className="mt-2.5 font-mono text-[11px] text-canvas-text-muted">
            实时尺寸渲染: <strong className="text-canvas-text">{val} × {val} px</strong>
          </span>
        </div>

        {/* 主控 Stepper */}
        <div className="flex flex-col items-center gap-2">
          <NumberStepper
            value={val}
            onChange={setVal}
            min={4}
            max={180}
            step={1}
            unit="px"
            size="lg"
            onScrubStateChange={setScrubbing}
            aria-label="试验台尺寸控制"
          />
          <div className="flex items-center gap-2 text-[11px] text-canvas-text-muted">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${scrubbing ? 'bg-brand animate-pulse' : 'bg-canvas-text-muted'}`} />
            <span>{scrubbing ? '左右滑动微调中… (按住 Shift 加速)' : '直接点击数字编辑，或左右拖拽、滚轮、上下按键调节'}</span>
            <button
              type="button"
              onClick={() => setVal(40)}
              className="ml-2 text-xs text-brand hover:underline"
            >
              重置 40px
            </button>
          </div>
        </div>
      </div>

      {/* 尺寸规格与状态 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col justify-between gap-3 rounded-lg border border-canvas-border bg-canvas-card p-3">
          <div>
            <div className="text-xs font-semibold text-canvas-text">紧凑型 · Mini 26px</div>
            <div className="mt-0.5 text-[11px] text-canvas-text-muted">密集浮动弹窗、节点内部</div>
          </div>
          <div className="flex items-center justify-center py-1">
            <NumberStepper value={24} onChange={() => {}} min={0} max={100} unit="px" size="sm" />
          </div>
        </div>

        <div className="flex flex-col justify-between gap-3 rounded-lg border border-canvas-border bg-canvas-card p-3">
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-canvas-text">标准型 · 32px</span>
              <span className="rounded bg-brand/15 px-1 py-0.2 text-[9px] font-bold text-brand">默认</span>
            </div>
            <div className="mt-0.5 text-[11px] text-canvas-text-muted">侧边属性栏、坐标调节首选</div>
          </div>
          <div className="flex items-center justify-center py-1">
            <NumberStepper value={40} onChange={() => {}} min={0} max={100} unit="px" size="md" />
          </div>
        </div>

        <div className="flex flex-col justify-between gap-3 rounded-lg border border-canvas-border bg-canvas-card p-3">
          <div>
            <div className="text-xs font-semibold text-canvas-text">突出型 · Prominent 40px</div>
            <div className="mt-0.5 text-[11px] text-canvas-text-muted">全局画布缩放、主工具栏</div>
          </div>
          <div className="flex items-center justify-center py-1">
            <NumberStepper value={100} onChange={() => {}} min={0} max={200} unit="%" size="lg" />
          </div>
        </div>

        <div className="flex flex-col justify-between gap-3 rounded-lg border border-canvas-border bg-canvas-card p-3">
          <div>
            <div className="text-xs font-semibold text-canvas-text">只读锁定 · Disabled</div>
            <div className="mt-0.5 text-[11px] text-canvas-text-muted">图层锁定或计算只读项</div>
          </div>
          <div className="flex items-center justify-center py-1">
            <NumberStepper value={40} onChange={() => {}} unit="px" disabled />
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-canvas-border bg-canvas-card p-3">
        <div className="mb-2 text-xs font-semibold text-canvas-text">多尺寸联动与状态响应</div>
        <p className="ui-hint mb-3">各尺寸档位均支持双向受控绑定；微调按钮随主题自动适配背景、描边与悬浮色。</p>
        <div className="flex flex-wrap items-center gap-3">
          <NumberStepper value={val} onChange={setVal} min={4} max={180} unit="px" size="sm" aria-label="紧凑数字微调" />
          <NumberStepper value={val} onChange={setVal} min={4} max={180} unit="px" size="md" aria-label="标准数字微调" />
          <NumberStepper value={val} onChange={setVal} min={4} max={180} unit="px" size="lg" aria-label="突出数字微调" />
          <NumberStepper value={val} onChange={setVal} unit="px" disabled aria-label="禁用数字微调" />
        </div>
      </div>

      {/* 工程场景与多单位 */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col justify-between rounded-lg border border-canvas-border bg-canvas-card p-3">
          <div className="mb-2 text-xs font-semibold text-canvas-text">双向滑块联动 (Slider Sync)</div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-canvas-text-secondary">不透明度</span>
            <NumberStepper value={opacity} onChange={setOpacity} min={0} max={100} unit="%" size="sm" />
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
            className="mt-3 h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-canvas-border accent-brand"
          />
        </div>

        <div className="rounded-lg border border-canvas-border bg-canvas-card p-3">
          <div className="mb-2 text-xs font-semibold text-canvas-text">物理工程单位适配</div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 rounded-md bg-canvas-surface/60 px-2.5 py-1.5">
              <div>
                <span className="text-xs font-medium text-canvas-text">旋转角度</span>
                <span className="ml-1.5 text-[10px] text-canvas-text-muted">0° ~ 360°</span>
              </div>
              <NumberStepper value={angle} onChange={setAngle} min={0} max={360} unit="deg" size="sm" />
            </div>

            <div className="flex items-center justify-between gap-2 rounded-md bg-canvas-surface/60 px-2.5 py-1.5">
              <div>
                <span className="text-xs font-medium text-canvas-text">动画过渡</span>
                <span className="ml-1.5 text-[10px] text-canvas-text-muted">步进 50ms</span>
              </div>
              <NumberStepper value={duration} onChange={setDuration} min={50} max={2000} step={50} unit="ms" size="sm" />
            </div>

            <div className="flex items-center justify-between gap-2 rounded-md bg-canvas-surface/60 px-2.5 py-1.5">
              <div>
                <span className="text-xs font-medium text-canvas-text">缩放倍率</span>
                <span className="ml-1.5 text-[10px] text-canvas-text-muted">浮点 0.1x</span>
              </div>
              <NumberStepper value={scale} onChange={setScale} min={0.1} max={10} step={0.1} precision={1} unit="x" size="sm" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 自定义 select：触发器和展开面板与 .ui-menu 完全一致，同时保留隐藏原生 <select> */
function CustomSelectDemo() {
  const [value, setValue] = useState('flux');
  const [runtime, setRuntime] = useState('blender');
  return (
    <div className="ui-field max-w-60">
      <label className="ui-label" htmlFor="sg-select-custom">图像模型</label>
      <Select fixedMenu id="sg-select-custom" value={value} onChange={setValue}
        options={[
          { value: 'flux', label: 'FLUX.1 [dev]' },
          { value: 'sdxl', label: 'SDXL 1.0' },
          { label: '其他模型', options: [
            { value: 'kolors', label: '可图 Kolors' },
            { value: 'custom', label: '自定义（未配置）', disabled: true },
          ] },
        ]} />
      <p className="ui-hint">当前值：{value}</p>
      <label className="ui-label" htmlFor="sg-select-content-width">窄按钮与长选项</label>
      <Select fixedMenu id="sg-select-content-width" size="sm" className="w-24"
        value={runtime} onChange={setRuntime}
        options={[
          { value: 'light', label: '轻量导演台' },
          { value: 'blender', label: 'Blender' },
          { value: 'extended', label: '带摄影机与灯光配置的导演台' },
        ]} />
      <p className="ui-hint">菜单按内容宽度展开，宽于或窄于按钮均可，最长不超过屏幕。</p>
    </div>
  );
}

/** 自定义下拉菜单：带图标、分组、危险项时用它，原生 select 表达不了 */
function DropdownMenuDemo() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('最近修改');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div className="ui-dropdown" ref={wrapRef}>
      <button
        type="button"
        className="ui-btn ui-btn--secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {selected}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open ? (
        <div className="ui-menu" role="menu">
          <span className="ui-menu__label">排序</span>
          {['最近修改', '名称 A→Z', '创建时间'].map((item) => (
            <button
              key={item}
              type="button"
              role="menuitem"
              className={`ui-menu__item${selected === item ? ' is-active' : ''}`}
              onClick={() => { setSelected(item); setOpen(false); }}
            >
              {item}
            </button>
          ))}
          <div className="ui-menu__sep" />
          <span className="ui-menu__label">操作</span>
          <button type="button" role="menuitem" className="ui-menu__item">
            导出为 JSON
            <span className="ui-menu__shortcut">Ctrl+E</span>
          </button>
          <button type="button" role="menuitem" className="ui-menu__item is-danger">
            删除工作区
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SelectsSection() {
  return (
    <Section
      id="sg-selects"
      title="下拉选择"
      desc="选择字段统一复用 Select 组件；支持键盘、分组及禁用项，菜单挂到页面顶层以避免父容器裁剪。"
    >
      <Demo label="自定义下拉（视觉与 .ui-menu 一致）" code="ui-select ui-select--custom > ui-select__trigger + ui-select__native + ui-menu">
        <CustomSelectDemo />
      </Demo>

      <Demo label="自定义菜单" code="ui-dropdown > ui-menu > ui-menu__label / ui-menu__item / ui-menu__sep / ui-menu__shortcut">
        <div className="pb-32">
          <DropdownMenuDemo />
          <p className="m-0 mt-2 text-[11px] text-canvas-text-muted">
            菜单浮层用 .ui-menu--right 右对齐、.ui-menu--up 向上展开
          </p>
        </div>
      </Demo>
    </Section>
  );
}

function DropzoneSection() {
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState('');

  return (
    <Section
      id="sg-dropzones"
      title="上传区"
      desc="按钮式文件选择适合工具栏和紧凑表单；拖放区适合批量导入。文件选择只交给调用方处理，不自动上传或保存。"
    >
      <Demo label="按钮上传 · 紧凑文件选择" code={'<FileUploadButton fileName={fileName} onChange={handleFile} /> · .ui-file-upload'}>
        <div className="ui-stack">
          <FileUploadButton aria-label="选择上传样例文件" fileName={fileName} onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) setFileName(file.name);
          }} />
          <FileUploadButton disabled label="选择文件" placeholder="当前不可上传" />
          <p className="ui-hint">支持键盘操作；长文件名自动省略，悬停可查看完整名称。</p>
        </div>
      </Demo>
      <Demo code="ui-dropzone > ui-dropzone__title / __icon / __hint（.is-dragover 高亮）">
        <div
          className={`ui-dropzone${dragOver ? ' is-dragover' : ''}`}
          onMouseEnter={() => setDragOver(true)}
          onMouseLeave={() => setDragOver(false)}
          role="button"
          tabIndex={0}
        >
          <span className="ui-dropzone__title">把工作流文件拖到这里</span>
          <span className="ui-dropzone__icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </span>
          <span className="ui-dropzone__hint">
            支持 ComfyUI 导出的 .json 工作流文件，点击这里也可以选择。
          </span>
        </div>
      </Demo>
    </Section>
  );
}

function SelectionSection() {
  const [switchOn, setSwitchOn] = useState(true);
  const [switchOff, setSwitchOff] = useState(false);
  const [slider, setSlider] = useState(65);
  const [segment, setSegment] = useState('grid');

  return (
    <Section
      id="sg-selection"
      title="选择控件"
      desc="开关用 button[aria-checked]，复选框/单选保留原生 input（.ui-checkbox + label 的相邻选择器负责画框），保证键盘与读屏可用。"
    >
      <Demo label="开关" code="<button className=&quot;ui-switch&quot; aria-checked={on} />">
        <div className="ui-row ui-row--loose">
          <label className="ui-row ui-row--tight">
            <button
              type="button"
              role="switch"
              aria-checked={switchOn}
              aria-label="自动保存"
              className="ui-switch"
              onClick={() => setSwitchOn((v) => !v)}
            />
            <span className="text-xs text-canvas-text">自动保存 {switchOn ? '开' : '关'}</span>
          </label>
          <label className="ui-row ui-row--tight">
            <button
              type="button"
              role="switch"
              aria-checked={switchOff}
              aria-label="硬件加速"
              className="ui-switch"
              onClick={() => setSwitchOff((v) => !v)}
            />
            <span className="text-xs text-canvas-text">硬件加速 {switchOff ? '开' : '关'}</span>
          </label>
          <button type="button" role="switch" aria-checked={false} aria-label="禁用开关" className="ui-switch" disabled />
        </div>
      </Demo>

      <Demo label="复选框与单选" code=".ui-checkbox + label / .ui-radio + label（原生 input，靠相邻选择器绘制）">
        <div className="ui-row ui-row--loose">
          <div className="relative ui-row ui-row--tight">
            <input id="sg-cb-a" type="checkbox" className="ui-checkbox" defaultChecked />
            <label htmlFor="sg-cb-a">已勾选</label>
          </div>
          <div className="relative ui-row ui-row--tight">
            <input id="sg-cb-b" type="checkbox" className="ui-checkbox" />
            <label htmlFor="sg-cb-b">未勾选</label>
          </div>
          <div className="relative ui-row ui-row--tight">
            <input id="sg-cb-c" type="checkbox" className="ui-checkbox" disabled />
            <label htmlFor="sg-cb-c">禁用</label>
          </div>
        </div>
        <div className="ui-row ui-row--loose">
          <div className="relative ui-row ui-row--tight">
            <input id="sg-rd-a" type="radio" name="sg-radio" className="ui-radio" defaultChecked />
            <label htmlFor="sg-rd-a">平衡</label>
          </div>
          <div className="relative ui-row ui-row--tight">
            <input id="sg-rd-b" type="radio" name="sg-radio" className="ui-radio" />
            <label htmlFor="sg-rd-b">质量优先</label>
          </div>
          <div className="relative ui-row ui-row--tight">
            <input id="sg-rd-c" type="radio" name="sg-radio" className="ui-radio" />
            <label htmlFor="sg-rd-c">速度优先</label>
          </div>
        </div>
      </Demo>

      <Demo label="滑块" code="<input type=&quot;range&quot; className=&quot;ui-slider&quot; />">
        <div className="ui-field" style={{ maxWidth: 320 }}>
          <label className="ui-label" htmlFor="sg-slider">画质权重 · {slider}%</label>
          <input
            id="sg-slider"
            type="range"
            className="ui-slider"
            min={0}
            max={100}
            value={slider}
            onChange={(e) => setSlider(Number(e.target.value))}
          />
        </div>
      </Demo>

      <Demo label="分段控件" code=".ui-segmented > .ui-segmented__item（.is-active 表示选中）">
        <div className="ui-segmented" role="tablist">
          {[
            { key: 'grid', label: '网格' },
            { key: 'list', label: '列表' },
            { key: 'board', label: '看板' },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={segment === item.key}
              className={`ui-segmented__item${segment === item.key ? ' is-active' : ''}`}
              onClick={() => setSegment(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </Demo>

      <Demo label="节点主题色分段" code="ui-segmented ui-segmented--node-text | --node-image | --node-video | --node-audio | --node-panorama">
        <div className="ui-segmented ui-segmented--node-text" role="tablist">
          {[
            { key: 'text', label: '文本' },
            { key: 'image', label: '图像' },
            { key: 'video', label: '视频' },
            { key: 'audio', label: '音频' },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={segment === item.key}
              className={`ui-segmented__item${segment === item.key ? ' is-active' : ''}`}
              onClick={() => setSegment(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </Demo>
    </Section>
  );
}

function TabsSection() {
  const [assetTab, setAssetTab] = useState('project');
  const [compactTab, setCompactTab] = useState('project');
  const [simpleTab, setSimpleTab] = useState('overview');
  const assetTabs = [
    { value: 'project', label: '项目文件', count: 12 },
    { value: 'global', label: '全局资产', count: 229 },
    { value: 'creative', label: '创作资产', count: 1 },
    { value: 'ark', label: '方舟素材库', count: 8 },
    { value: 'nodes', label: '节点列表', count: 36 },
  ];
  return (
    <Section id="sg-tabs" title="Tabs · 滚动页签"
      desc="下划线与计数徽标复用真实 Tabs 组件。选中项尽量居中，末项靠右；略微越过目标后回弹，滚动边界也保留弹性。支持方向键、Home/End 和系统减少动态效果。">
      <Demo label="带计数 · 横向滚动与弹簧回弹"
        code={'<Tabs items={items} value={value} onChange={setValue} aria-label="资产类型" /> · .ui-tabs / .ui-tabs__item / .ui-tabs__count'}>
        <div className="w-full max-w-sm">
          <Tabs items={assetTabs} value={assetTab} onChange={setAssetTab} aria-label="带计数页签演示" />
        </div>
        <p className="m-0 mt-2 text-xs text-canvas-text-secondary">点击右侧页签查看居中与回弹，末项会滚到最右侧。</p>
      </Demo>
      <Demo label="紧凑尺寸 · 资产库侧栏"
        code={'<Tabs size="sm" items={items} value={value} onChange={setValue} aria-label="资产类型" /> · .ui-tabs--sm'}>
        <div className="w-full max-w-xs">
          <Tabs size="sm" items={assetTabs} value={compactTab} onChange={setCompactTab} aria-label="紧凑页签演示" />
        </div>
      </Demo>
      <Demo label="无计数与禁用状态"
        code="items: [{ value, label, count?, disabled? }] · .is-active / :disabled / :focus-visible">
        <Tabs items={[
          { value: 'overview', label: '概览' },
          { value: 'details', label: '详细信息' },
          { value: 'unavailable', label: '暂不可用', disabled: true },
          { value: 'history', label: '操作记录' },
        ]} value={simpleTab} onChange={setSimpleTab} aria-label="基础页签演示" />
      </Demo>
    </Section>
  );
}

function CardsSection() {
  const [selectedId, setSelectedId] = useState<string | null>('shot-02');

  const shots = [
    { id: 'shot-01', title: '开场 · 城市全景', desc: '无人机俯拍 · 4s', badge: '待生成' },
    { id: 'shot-02', title: '特写 · 主角侧脸', desc: '85mm 定焦 · 3s', badge: '已生成' },
    { id: 'shot-03', title: '过肩 · 对话正反打', desc: '双机位 · 6s', badge: '待生成' },
  ];

  return (
    <Section
      id="sg-cards"
      title="卡片"
      desc="卡片只负责「一块内容」的容器语义：header 放标题与操作，body 放内容，footer 放行动按钮。选中态用 .is-selected，不要改背景以免和 hover 冲突。"
    >
      <Demo label="基础卡片" code=".ui-card > .ui-card__header / __title / __body / __footer">
        <div className="ui-card" style={{ maxWidth: 360 }}>
          <div className="ui-card__header">
            <div className="min-w-0">
              <h3 className="ui-card__title">分镜脚本</h3>
              <p className="ui-card__desc">共 12 个镜头 · 最近修改 2 分钟前</p>
            </div>
            <div className="ui-card__header-actions">
              <button type="button" className="ui-icon-btn ui-icon-btn--sm" aria-label="更多">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />
                </svg>
              </button>
            </div>
          </div>
          <div className="ui-card__body">
            按镜头顺序编排画面描述、景别与运镜，生成时自动串成一条时间线。
          </div>
          <div className="ui-card__footer">
            <span className="ui-badge ui-badge--outline">草稿</span>
            <div className="ui-card__footer-actions">
              <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm">放弃</button>
              <button type="button" className="ui-btn ui-btn--primary ui-btn--sm">继续编辑</button>
            </div>
          </div>
        </div>
      </Demo>

      <Demo label="可交互卡片与选中态" code=".ui-card--interactive / .is-selected">
        <div className="grid gap-3 sm:grid-cols-3">
          {shots.map((shot) => (
            <button
              key={shot.id}
              type="button"
              aria-pressed={selectedId === shot.id}
              className={`ui-card ui-card--interactive${selectedId === shot.id ? ' is-selected' : ''}`}
              onClick={() => setSelectedId(shot.id)}
            >
              <div className="ui-card__body">
                <p className="m-0 mb-1 text-xs font-medium text-canvas-text">{shot.title}</p>
                <p className="m-0 text-[11px] text-canvas-text-muted">{shot.desc}</p>
              </div>
              <div className="ui-card__footer">
                <span className={`ui-badge ${shot.badge === '已生成' ? 'ui-badge--success' : 'ui-badge--outline'}`}>
                  {shot.badge}
                </span>
              </div>
            </button>
          ))}
        </div>
      </Demo>

      <Demo label="指标卡" code=".ui-stat > .ui-stat__value / .ui-stat__label">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="ui-stat">
            <span className="ui-stat__value">128</span>
            <span className="ui-stat__label">画布节点</span>
          </div>
          <div className="ui-stat">
            <span className="ui-stat__value">32.4 MB</span>
            <span className="ui-stat__label">项目资产</span>
          </div>
          <div className="ui-stat">
            <span className="ui-stat__value">6</span>
            <span className="ui-stat__label">已接入厂商</span>
          </div>
        </div>
      </Demo>
    </Section>
  );
}

function BadgesSection() {
  const [tags, setTags] = useState(['角色', '夜景', '雨']);

  return (
    <Section
      id="sg-badges"
      title="徽标与表格"
      desc="徽标用圆角胶囊 + 淡底；密集列表里改用 .ui-badge--outline，避免底色抢视觉。"
    >
      <Demo label="徽标" code="ui-badge ui-badge--primary | --success | --info | --warning | --danger | --outline">
        <div className="ui-row">
          <span className="ui-badge ui-badge--primary">品牌</span>
          <span className="ui-badge ui-badge--success">成功</span>
          <span className="ui-badge ui-badge--info">信息</span>
          <span className="ui-badge ui-badge--warning">警告</span>
          <span className="ui-badge ui-badge--danger">危险</span>
          <span className="ui-badge">中性</span>
          <span className="ui-badge ui-badge--outline">描边款</span>
          <span className="ui-badge ui-badge--success"><i className="ui-badge__dot" />运行中</span>
        </div>
      </Demo>

      <Demo label="可移除标签" code=".ui-tag > .ui-tag__remove">
        <div className="ui-row">
          {tags.map((tag) => (
            <span key={tag} className="ui-tag">
              {tag}
              <button
                type="button"
                className="ui-tag__remove"
                aria-label={`移除 ${tag}`}
                onClick={() => setTags((list) => list.filter((t) => t !== tag))}
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </span>
          ))}
          {tags.length === 0 ? (
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setTags(['角色', '夜景', '雨'])}>
              重置标签
            </button>
          ) : null}
        </div>
      </Demo>

      <Demo label="表格" code=".ui-table">
        <table className="ui-table">
          <thead>
            <tr>
              <th>连接</th>
              <th>厂商</th>
              <th>状态</th>
              <th>模型数</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="text-canvas-text">主账号</td>
              <td>OpenAI</td>
              <td><span className="ui-badge ui-badge--success"><i className="ui-badge__dot" />可用</span></td>
              <td>24</td>
            </tr>
            <tr>
              <td className="text-canvas-text">备用</td>
              <td>火山方舟</td>
              <td><span className="ui-badge ui-badge--warning"><i className="ui-badge__dot" />限流</span></td>
              <td>11</td>
            </tr>
            <tr>
              <td className="text-canvas-text">本地</td>
              <td>ComfyUI</td>
              <td><span className="ui-badge ui-badge--outline">未连接</span></td>
              <td>0</td>
            </tr>
          </tbody>
        </table>
      </Demo>

      <Demo label="列表" code=".ui-list > .ui-list__item（--interactive 可点，.is-active 选中）">
        <div className="ui-list">
          <div className="ui-list__item ui-list__item--interactive is-active">
            最近使用
            <span className="ui-list__trailing">12</span>
          </div>
          <div className="ui-list__item ui-list__item--interactive">
            我的收藏
            <span className="ui-list__trailing">48</span>
          </div>
          <div className="ui-list__item">
            回收站
            <span className="ui-list__trailing">3</span>
          </div>
        </div>
      </Demo>
    </Section>
  );
}

function FeedbackSection() {
  return (
    <Section
      id="sg-feedback"
      title="反馈与状态"
      desc="提示条承载一句话结论，进度条只给「可预期等待」，空状态必须给出下一步动作。"
    >
      <Demo label="提示条" code=".ui-alert--info | --success | --warning | --danger">
        <div className="ui-stack ui-stack--tight">
          <div className="ui-alert ui-alert--info">
            <span className="ui-alert__icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
            </span>
            <div className="ui-alert__body">上下文已压缩，较早的对话被折叠为主题摘要。</div>
          </div>
          <div className="ui-alert ui-alert--success">
            <span className="ui-alert__icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
            </span>
            <div className="ui-alert__body">
              <p className="ui-alert__title">项目已保存</p>
              共 24 个节点、6 个连接写入本地。
            </div>
          </div>
          <div className="ui-alert ui-alert--warning">
            <span className="ui-alert__icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
            </span>
            <div className="ui-alert__body">本次生成将消耗约 12 积分，继续？</div>
          </div>
          <div className="ui-alert ui-alert--danger">
            <span className="ui-alert__icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
            </span>
            <div className="ui-alert__body">厂商连接失败：API Key 无效或已过期。</div>
          </div>
        </div>
      </Demo>

      <Demo label="进度与加载" code=".ui-progress（--success / --danger / --indeterminate）/ .ui-spinner / .ui-skeleton">
        <div className="ui-stack ui-stack--tight">
          <div className="ui-progress"><div className="ui-progress__bar" style={{ width: '65%' }} /></div>
          <div className="ui-progress ui-progress--success"><div className="ui-progress__bar" style={{ width: '100%' }} /></div>
          <div className="ui-progress ui-progress--danger"><div className="ui-progress__bar" style={{ width: '35%' }} /></div>
          <div className="ui-progress ui-progress--indeterminate"><div className="ui-progress__bar" /></div>
          <div className="ui-row ui-row--loose">
            <span className="ui-row ui-row--tight text-xs text-canvas-text-secondary"><span className="ui-spinner" /> 加载中</span>
            <div className="ui-stack ui-stack--tight" style={{ width: 220 }}>
              <div className="ui-skeleton" style={{ height: 10, width: '100%' }} />
              <div className="ui-skeleton" style={{ height: 10, width: '70%' }} />
            </div>
          </div>
        </div>
      </Demo>

      <Demo label="空状态" code=".ui-empty > .ui-empty__icon / __title / __desc">
        <div className="ui-empty">
          <span className="ui-empty__icon" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 10h8M8 14h5" strokeLinecap="round" />
            </svg>
          </span>
          <p className="ui-empty__title">还没有工作流</p>
          <p className="ui-empty__desc">导入 ComfyUI 工作流 JSON，或从模板新建一个。</p>
          <button type="button" className="ui-btn ui-btn--primary ui-btn--sm">导入工作流</button>
        </div>
      </Demo>
    </Section>
  );
}

function LayoutSection() {
  return (
    <Section
      id="sg-layout"
      title="布局辅助"
      desc="只把跨模块反复出现的排布收进类里；业务自己的布局仍然优先用 Tailwind。"
    >
      <Demo label="行与栈" code=".ui-row（--tight / --loose / --between / --baseline）/ .ui-stack（--tight / --loose / --pad-sm / --pad）">
        <div className="ui-stack">
          <div className="ui-row">
            <span className="ui-badge">默认 8px</span>
            <span className="ui-badge">默认 8px</span>
          </div>
          <div className="ui-row ui-row--tight">
            <span className="ui-badge">紧凑 4px</span>
            <span className="ui-badge">紧凑 4px</span>
          </div>
          <div className="ui-row ui-row--between">
            <span className="text-xs text-canvas-text-secondary">两端对齐</span>
            <span className="ui-badge ui-badge--primary">右侧</span>
          </div>
        </div>
      </Demo>

      <Demo
        label="默认内边距"
        code="默认使用 p-2（8px · 紧凑/列表/子卡片）或 p-3（12px · 默认容器/卡片/弹窗）；避免使用过大 padding"
      >
        <div className="ui-row ui-row--loose">
          <div className="ui-stack ui-stack--tight">
            <div className="rounded-md border border-canvas-border bg-canvas-surface p-2 text-center text-xs">
              <span className="font-mono font-medium text-canvas-text">p-2</span>
              <span className="ml-1 text-[11px] text-canvas-text-muted">8px · 紧凑 / 子卡片 / 列表项</span>
            </div>
            <span className="text-[10px] text-canvas-text-muted">.ui-pad-sm / p-2</span>
          </div>
          <div className="ui-stack ui-stack--tight">
            <div className="rounded-md border border-canvas-border bg-canvas-surface p-3 text-center text-xs">
              <span className="font-mono font-medium text-canvas-text">p-3</span>
              <span className="ml-1 text-[11px] text-canvas-text-muted">12px · 默认容器 / 面板 / 卡片</span>
            </div>
            <span className="text-[10px] text-canvas-text-muted">.ui-pad / p-3（推荐默认）</span>
          </div>
        </div>
      </Demo>

      <Demo label="分隔线" code=".ui-divider / .ui-divider--vertical">
        <div className="ui-stack ui-stack--tight">
          <span className="text-xs text-canvas-text-secondary">上方内容</span>
          <hr className="ui-divider" />
          <span className="text-xs text-canvas-text-secondary">下方内容</span>
        </div>
        <div className="ui-row" style={{ height: 20 }}>
          <span className="text-xs text-canvas-text-secondary">左</span>
          <span className="ui-divider ui-divider--vertical" />
          <span className="text-xs text-canvas-text-secondary">右</span>
        </div>
      </Demo>

      <Demo label="圆角与控件高度" code="--ui-radius-sm 6 / --ui-radius-md 7 / --ui-radius 8 / --ui-radius-lg 12 / --ui-radius-xl 14；--ui-control-h 32（sm 26 / lg 40）">
        <div className="ui-row ui-row--loose">
          {[
            { v: 'var(--ui-radius-sm)', label: 'sm · 6px' },
            { v: 'var(--ui-radius-md)', label: 'md · 7px（输入/按钮/chip）' },
            { v: 'var(--ui-radius)', label: '默认 · 8px' },
            { v: 'var(--ui-radius-lg)', label: 'lg · 12px' },
            { v: 'var(--ui-radius-xl)', label: 'xl · 14px（上传区/大卡片）' },
          ].map((item) => (
            <div key={item.label} className="ui-stack ui-stack--tight" style={{ alignItems: 'center' }}>
              <span
                className="h-10 w-10 border border-canvas-border bg-canvas-card"
                style={{ borderRadius: item.v }}
                aria-hidden="true"
              />
              <span className="text-[10px] text-canvas-text-muted">{item.label}</span>
            </div>
          ))}
        </div>
      </Demo>
    </Section>
  );
}

/* ==========================================================================
   内容装配
   ========================================================================== */
function TimelineDemo() {
  const [playhead, setPlayhead] = useState(12);
  const [markers, setMarkers] = useState([{ id: 'cut-demo', time: 20 }]);
  const boundaries = [0, ...markers.map((marker) => marker.time).sort((a, b) => a - b), 60];
  return <Demo label="共用时间轴 · 时间码刻度与图标工具栏" code="Timeline / TimelineRuler / TimelineThumbnails · ui-timeline / ui-icon-btn--ghost">
    <Timeline duration={60} playhead={playhead} onSeek={setPlayhead} thumbnails={[]} markers={markers}
      segments={boundaries.slice(0, -1).map((start, index) => ({ id: String(index), start, end: boundaries[index + 1], label: `${index + 1}: ${start.toFixed(1)}–${boundaries[index + 1].toFixed(1)}s` }))}
      labels={{ title: '时间轴', playhead: '播放头', track: '示例视频', segments: '分段', addMarker: '添加切点',
        removeMarker: '删除切点', resetMarkers: '恢复自动分段', zoomIn: '放大', zoomOut: '缩小', fit: '适应', position: '位置（秒）', marker: '切点' }}
      onAddMarker={(time) => { if (time > 0 && time < 60 && !markers.some((marker) => Math.abs(marker.time - time) < 0.001)) setMarkers([...markers, { id: crypto.randomUUID(), time }]); }}
      onMoveMarker={(id, time) => { if (time > 0 && time < 60 && !markers.some((marker) => marker.id !== id && Math.abs(marker.time - time) < 0.001)) setMarkers(markers.map((marker) => marker.id === id ? { ...marker, time } : marker)); }}
      onRemoveMarker={(id) => setMarkers(markers.filter((marker) => marker.id !== id))} onResetMarkers={() => setMarkers([])} />
  </Demo>;
}

function VideoPlayerSection() {
  const [media, setMedia] = useState<{ src: string; name: string } | null>(null);
  const [compact, setCompact] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => { if (media) URL.revokeObjectURL(media.src); }, [media]);
  return <Section id="sg-video-player" title="视频播放器" desc="公用 VideoPlayer；主题色进度、倍速、音量、悬停预览与全屏。进度滑块悬浮轻微放大，拖动时按方向倾斜，松手回弹恢复；支持减少动态效果。音量使用 ui-slider，在按钮右侧同一行展开；紧凑模式时间靠右。下方展示共用 Timeline 的缩放、打点和切点调整。选择本地视频试播，样例仅在本窗口使用，关闭或替换时释放资源。">
    <Demo code={'<VideoPlayer src={videoUrl} name="示例视频" compact={compact} onMetadata={handleMetadata} /> · ui-video-player--compact'}>
      <div className="ui-stack">
        <div className="ui-row">
          <FileUploadButton label="选择视频" accept="video/*" aria-label="选择视频样例" fileName={media?.name ?? ''} placeholder="选择本地视频试播" className="min-w-0 flex-1" onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (!file) return;
            if (file.type && !file.type.startsWith('video/')) { setError('请选择视频文件'); return; }
            setError(''); setMedia({ src: URL.createObjectURL(file), name: file.name });
          }} />
          <button type="button" className="ui-btn ui-btn--ghost" disabled={!media} onClick={() => setMedia(null)}>移除样例</button>
          <button type="button" className={`ui-btn ui-btn--ghost${compact ? ' is-active' : ''}`} aria-pressed={compact} onClick={() => setCompact(!compact)}>紧凑模式</button>
        </div>
        {error && <p role="status" className="text-xs text-canvas-text-secondary">{error}</p>}
        <div className={`${compact ? 'h-[158px] w-[280px] max-w-full' : 'h-[380px]'} min-w-0 rounded-lg bg-canvas-bg`}>
          <VideoPlayer key={media?.src ?? 'empty'} src={media?.src} name={media?.name ?? '视频样例'} unavailable={!media} compact={compact} />
        </div>
      </div>
    </Demo>
    <TimelineDemo />
  </Section>;
}

function MarkdownEditorSection() {
  const [value, setValue] = useState('# Markdown 编辑器\n\n资源文件与节点大屏共用真实组件。支持 **粗体**、*斜体* 和 [链接](https://example.com)。\n\n- [x] 编辑与预览\n- [ ] 查找替换\n\n| 功能 | 状态 |\n| --- | --- |\n| 分栏预览 | 可用 |\n\n```ts\nconst message = "Hello";\n```');
  return <Section id="sg-markdown-editor" title="Markdown 编辑器" desc="受控组件；保存策略由宿主提供。支持格式工具、分栏预览、查找替换、撤销重做与字数统计。">
    <Demo code={'<MarkdownEditor value={value} onChange={setValue} initialMode="split" /> · ui-markdown-editor'}>
      <div className="h-[480px] min-w-0"><MarkdownEditor value={value} onChange={setValue} status="交互样例 · 不写入磁盘" /></div>
    </Demo>
  </Section>;
}

export function StyleGuideContent({ theme }: { theme: 'dark' | 'light' }) {
  return (
    <>
      <header className="mb-7">
        <h2 className="m-0 text-lg font-semibold text-canvas-text">AI Canvas · UI Kit</h2>
        <p className="m-0 mt-1 text-xs leading-relaxed text-canvas-text-secondary">
          全应用公用控件一览。样式定义在 <code className="ui-code">src/styles/ui-kit.css</code>，
          颜色与间距全部来自 <code className="ui-code">src/styles/base.css</code> 的 CSS 变量。
          写新界面时先来这里挑控件，不要另造一套；点击每个样例下方的类名即可复制。
        </p>
      </header>

      <ColorsSection />
      <TypographySection />
      <ButtonsSection theme={theme} />
      <ChipsSection />
      <InputsSection />
      <SelectsSection />
      <DropzoneSection />
      <SelectionSection />
      <TabsSection />
      <CardsSection />
      <BadgesSection />
      <FeedbackSection />
      <Section id="sg-generation-effects" title="生成特效" desc="生成思考球、对话框边框流光与金属按钮，复用画布中的真实组件。">
        <StyleGuideGenerationEffects theme={theme} />
      </Section>
      <VideoPlayerSection />
      <MarkdownEditorSection />
      <Section id="sg-mascot" title="吉祥物" desc="预览真实吉祥物的状态、表情与身体动作，支持循环演示和不同尺寸查看。">
        <StyleGuideMascot theme={theme} />
      </Section>
      <LayoutSection />
    </>
  );
}
