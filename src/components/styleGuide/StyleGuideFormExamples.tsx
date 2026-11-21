import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Select from '../shared/Select';
import NumberStepper from '../shared/NumberStepper';

/** 数字微调步进输入框展示：包含实时试验台、尺寸与状态矩阵、单位与联动场景 */
export function NumberStepperDemo() {
  const [val, setVal] = useState(40);
  const [scrubbing, setScrubbing] = useState(false);
  const [opacity, setOpacity] = useState(85);
  const [angle, setAngle] = useState(90);
  const [duration, setDuration] = useState(350);
  const [scale, setScale] = useState(1.2);
  const [draftValue, setDraftValue] = useState(-1.5);

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

      <div className="ui-card p-3">
        <label className="ui-label" htmlFor="sg-number-draft">键入草稿与边界 · 无单位</label>
        <div className="ui-row mt-2">
          <NumberStepper id="sg-number-draft" value={draftValue} onChange={setDraftValue}
            min={-10} max={10} step={0.5} precision={1} />
          <output className="text-xs tabular-nums text-canvas-text-secondary">已提交值：{draftValue.toFixed(1)}</output>
        </div>
        <p className="ui-hint mt-2">支持负数与小数；编辑时可暂留空值或负号，Enter 或失焦提交并限制在 −10～10，Esc 放弃草稿。可键入 −2.5、99 或无效文本比较结果。</p>
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
export function CustomSelectDemo() {
  const [value, setValue] = useState('flux');
  const [runtime, setRuntime] = useState('blender');
  return (
    <div className="ui-field max-w-60">
      <label className="ui-label" htmlFor="sg-select-custom">图像模型</label>
      <Select id="sg-select-custom" value={value} onChange={setValue}
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
      <Select id="sg-select-content-width" size="sm" className="w-24"
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
export function DropdownMenuDemo() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('最近修改');
  const [result, setResult] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const current = menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    const first = menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    (current ?? first)?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const current = items.findIndex((item) => item === document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div className="ui-stack ui-stack--tight">
      <div className="ui-dropdown max-w-full self-start" ref={wrapRef}
        onBlur={(event) => {
          // 向前 Tab 保留浏览器原生顺序，焦点离开后收起。
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
        }}>
        <button
          ref={triggerRef}
          id="sg-menu-trigger"
          type="button"
          className="ui-btn ui-btn--secondary max-w-full"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? 'sg-action-menu' : undefined}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            setOpen(true);
          }}
        >
          <span className="min-w-0 truncate">{selected}</span>
          <svg className="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {open ? (
          <div ref={menuRef} id="sg-action-menu" className="ui-menu w-72 max-w-[calc(100vw-32px)]" role="menu"
            aria-labelledby="sg-menu-trigger" onKeyDown={handleMenuKeyDown}>
            <span className="ui-menu__label" role="presentation">排序</span>
            {['最近修改', '名称 A→Z', '创建时间', '名称包含非常长的项目与工作区描述时，仍保持菜单宽度和完整名称提示'].map((item) => (
              <button
                key={item}
                type="button"
                role="menuitemradio"
                aria-checked={selected === item}
                tabIndex={-1}
                title={item}
                className={`ui-menu__item${selected === item ? ' is-active' : ''}`}
                onClick={() => { setSelected(item); closeMenu(); }}
              >
                <span className="min-w-0 truncate">{item}</span>
              </button>
            ))}
            <button type="button" role="menuitemradio" aria-checked={false} tabIndex={-1} className="ui-menu__item" disabled>按使用频率排序（暂不可用）</button>
            <div className="ui-menu__sep" role="separator" />
            <span className="ui-menu__label" role="presentation">操作</span>
            <button type="button" role="menuitem" tabIndex={-1} className="ui-menu__item"
              onClick={() => { setResult('已触发导出 JSON 样例。'); closeMenu(); }}>
              导出为 JSON
              <span className="ui-menu__shortcut">Ctrl+E</span>
            </button>
            <button type="button" role="menuitem" tabIndex={-1} className="ui-menu__item is-danger"
              onClick={() => { setResult('已触发删除工作区样例。'); closeMenu(); }}>
              删除工作区
            </button>
          </div>
        ) : null}
      </div>
      {result && <p className="ui-hint" role="status">{result}</p>}
    </div>
  );
}
