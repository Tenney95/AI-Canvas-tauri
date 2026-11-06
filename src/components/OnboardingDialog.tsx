/**
 * 入口引导后的可选操作技巧，内容与帮助中心集中维护。
 */
import { Icon } from '@iconify/react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useAppStore } from '../store/useAppStore';
import { getCanvasGuideLayout } from '../utils/canvasGuideLayout';
import ModalOverlay from './shared/ModalOverlay';
import PopupCloseButton from './shared/PopupCloseButton';
import AnimatedButton from './shared/AnimatedButton';
import { useT } from '../i18n';

/** 入口说明集中维护；实际高亮与交互由 CanvasEntryGuide 复用真实界面。 */
const CANVAS_ENTRY_GUIDE_STEPS = [
  { id: 'projects', side: 'bottom', icon: 'lucide:panels-top-left', title: '顶部项目与设置',
    description: '把鼠标移到顶部中央的短线上，可以展开最近打开的项目；点击项目名称切换，齿轮按钮打开当前项目设置。',
    hint: '常用入口平时收起，让画布保留更多空间。' },
  { id: 'history', side: 'left', icon: 'lucide:history', title: '右上角操作记录',
    description: '鼠标移到右上方的短竖线，可查看操作记录、撤销和重做。点击图钉可以让面板保持显示。',
    hint: '误操作时也可以使用 Ctrl/⌘ + Z 撤销。' },
  { id: 'series', side: 'left', icon: 'lucide:clapperboard', title: '右侧剧集与项目资产',
    description: '鼠标悬浮右侧中间的短竖线即可展开剧集栏，可编辑剧本、管理分集；双击这条线打开项目资产。',
    hint: '左上角加号也可以创建分集，创建时可填写名称。' },
  { id: 'storage', side: 'bottom', icon: 'lucide:folder-cog', title: '先确认文件保存位置',
    description: '这里可以选择文件保存根目录，并查看当前项目目录。未设置时使用系统默认目录；生成和导入素材前，可以先确认保存位置。',
    hint: '引导不会更改路径。点击“开始设置”后，再由你选择文件夹。' },
] as const;

/** 每条都带 tooltip：正文只写动作，前提和限制放到悬停里，顺带让用户习惯悬停看说明。 */
const HIDDEN_TIPS = [
  {
    icon: 'mdi:keyboard-space',
    shortcut: '选中节点 + Space',
    title: '打开节点的提示词对话框',
    description: '单独选中一个内容节点后按空格，直接展开提示词、参数和参考内容的完整编辑面板。',
    tooltip: '只在单独选中一个普通内容节点时生效；正在输入文字、多选节点、分组节点或 Markdown 节点都不会触发。',
  },
  {
    icon: 'mdi:image-multiple-outline',
    shortcut: '长按生成按钮',
    title: '图像节点批量出图',
    description: '在图像节点对话框里填好提示词，长按发送/生成按钮，可以选择一次生成 2-8 张。',
    tooltip: '需要使用支持批量的普通模型且未选择 ComfyUI 工作流；费用可能按实际生成张数计算。',
  },
  {
    icon: 'mdi:dock-top',
    shortcut: '长按节点工具栏',
    title: '自定义节点工具栏',
    description: '单独选中节点后长按上方浮动工具栏，进入编辑状态，可增删按钮或拖拽排序。',
    tooltip: '编辑完成后布局会被保存，之后同类节点都用这套工具栏。',
  },
  {
    icon: 'mdi:content-duplicate',
    shortcut: 'Ctrl/⌘ + 拖动节点',
    title: '拖一下就留副本',
    description: '按住 Ctrl/⌘ 拖动非分组节点，原位置会留下一个副本，省去复制粘贴再对位。',
    tooltip: '分组节点不支持这个手势；误操作可用 Ctrl/⌘ + Z 撤销。',
  },
  {
    icon: 'mdi:resize',
    shortcut: '拖拽缩放 + Shift',
    title: '锁定节点宽高比例',
    description: '拖动节点右下角尺寸控制点时按住 Shift，宽高按当前比例一起变化。',
    tooltip: '拖拽过程中可以随时按下或松开 Shift 来切换是否锁定比例。',
  },
  {
    icon: 'mdi:vector-polyline-plus',
    shortcut: '连线拖到空白处',
    title: '边连线边建节点',
    description: '从输出连接点拖出连线，松手在画布空白处，会直接弹出菜单创建已连好的下游节点。',
    tooltip: '菜单里选择的节点类型会自动放在松手的位置，并保留这条连线。',
  },
  {
    icon: 'mdi:numeric',
    shortcut: '1-7 / Alt + 1-5',
    title: '在鼠标位置直接建节点',
    description: '按 1-7 创建文本、图像、视频、音频、全景、动画和 3D 导演台节点；Alt + 1-5 创建对应的源节点。',
    tooltip: '节点会出现在当前鼠标所在的画布位置，不需要先点加号菜单。',
  },
  {
    icon: 'mdi:slash-forward',
    shortcut: '在提示词里输入 /',
    title: '快捷指令与 Skill 菜单',
    description: '在生成节点的提示词输入框里键入 /，可调用内置指令、自定义快捷指令和已上传的 Skill。',
    tooltip: '也可以点输入框下方的 / 按钮；在“管理快捷指令”里能定义自己的模板、参数和多步骤流程。',
  },
  {
    icon: 'mdi:magnify',
    shortcut: 'Alt + Space',
    title: '跨范围搜索素材',
    description: '打开资源搜索窗口，聚合查询项目文件、全局资产和已添加的外部文件夹，结果可直接拖进画布。',
    tooltip: 'Ctrl + Shift + Space 是同一个入口的备用组合键。',
  },
  {
    icon: 'mdi:fit-to-screen-outline',
    shortcut: 'F / M',
    title: '找回跑远的画布内容',
    description: '按 F 把全部内容适配到当前视野，按 M 显示或隐藏小地图。',
    tooltip: '画布右下角还有缩放控件，可以精确调整显示比例。',
  },
] as const;

interface OnboardingDialogProps {
  onClose: () => void;
  onOpenHelp: () => void;
}

export default function OnboardingDialog({ onClose, onOpenHelp }: OnboardingDialogProps) {
  const t = useT();
  return (
    <ModalOverlay
      isOpen
      onClose={onClose}
      closeOnBackdrop={false}
      ariaLabel={t('AI Canvas 新手引导')}
      className="h-[min(660px,calc(100vh-24px))] w-[min(620px,calc(100vw-24px))]"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-canvas-border px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-400">
            <Icon icon="mdi:hand-wave-outline" width="20" height="20" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-canvas-text">{t('欢迎使用 AI Canvas')}</h2>
            <p className="mt-0.5 truncate text-xs text-canvas-text-secondary">{t('花两分钟看完，能少走很多弯路')}</p>
          </div>
        </div>
        <PopupCloseButton ariaLabel={t('关闭引导')} onClick={onClose} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <section
          data-tooltip={t('像现在这样——把鼠标停在元素上不动，说明就会自己浮出来。')}
          className="flex gap-3 rounded-xl border border-indigo-400/25 bg-indigo-500/10 p-3"
        >
          <Icon icon="mdi:cursor-default-outline" width="20" height="20" className="mt-0.5 shrink-0 text-indigo-400" aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-canvas-text">{t('先养成一个习惯：多悬停')}</h3>
            <p className="mt-1.5 text-xs leading-5 text-canvas-text-secondary">
              {t('界面上几乎每个按钮、图标和开关都写了说明。把鼠标停在上面约 1 秒，说明就会浮出来。')}
              {t('遇到不认识的图标，先悬停看一眼再点，比点开试错快得多——这段文字本身也可以悬停试试。')}
            </p>
          </div>
        </section>

        <section className="mt-3 flex gap-3 rounded-xl border border-amber-400/30 bg-amber-500/10 p-3">
          <Icon icon="mdi:speedometer" width="20" height="20" className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-amber-300">
              {t('界面卡顿或显示不全？开启性能模式')}
            </h3>
            <p className="mt-1.5 text-xs leading-5 text-amber-200/80">
              {t('前往“设置 > 常规 > 图形与性能”开启。它会关闭毛玻璃、装饰动画和动态背景，同时保留加载与进度提示。')}
            </p>
          </div>
        </section>

        <div className="mt-5 mb-2 flex items-center gap-2">
          <Icon icon="mdi:eye-off-outline" width="16" height="16" className="shrink-0 text-canvas-text-muted" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-canvas-text">{t('这些操作藏在界面里，不说很难发现')}</h3>
        </div>
        <p className="mb-3 text-xs leading-5 text-canvas-text-muted">
          {t('下面每一条都可以悬停查看适用条件和限制。')}
        </p>

        <ul className="space-y-1">
          {HIDDEN_TIPS.map((tip) => (
            <li
              key={tip.title}
              data-tooltip={t(tip.tooltip)}
              className="flex gap-3 rounded-lg border-b border-canvas-border/70 px-2 py-3 transition-colors last:border-b-0 hover:bg-canvas-hover"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-canvas-hover text-canvas-text-secondary">
                <Icon icon={tip.icon} width="16" height="16" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-medium text-canvas-text">{t(tip.title)}</h4>
                  <kbd className="rounded-md border border-canvas-border bg-canvas-hover px-1.5 py-0.5 font-sans text-[10px] font-medium text-canvas-text-secondary">
                    {t(tip.shortcut)}
                  </kbd>
                </div>
                <p className="mt-1.5 text-xs leading-5 text-canvas-text-secondary">{t(tip.description)}</p>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-5 flex items-start gap-2 border-t border-canvas-border pt-4 text-xs leading-5 text-canvas-text-muted">
          <Icon icon="mdi:information-outline" width="16" height="16" className="mt-0.5 shrink-0" aria-hidden="true" />
          <p>
            {t('开始生成前，记得先在“设置 > API Key”配置好模型服务，否则节点里的模型会是不可用状态。')}
            {t('之后可从侧边栏头像菜单的「帮助」查看完整说明，也可以重新查看画布入口引导。')}
          </p>
        </div>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-canvas-border px-4 py-3">
        <AnimatedButton
          type="button"
          onClick={onClose}
          className="rounded-lg px-3 py-2 text-xs text-canvas-text-secondary transition-colors hover:bg-canvas-hover hover:text-canvas-text"
        >
          {t('先自己逛逛')}
        </AnimatedButton>
        <AnimatedButton
          type="button"
          data-tooltip={t('按场景整理的完整说明：画布导航、节点连线、AI 生成、快捷指令、资产与设置')}
          onClick={onOpenHelp}
          className="flex items-center gap-1.5 rounded-lg bg-indigo-500/90 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-indigo-500"
        >
          <Icon icon="mdi:book-open-page-variant-outline" width="15" height="15" aria-hidden="true" />
          {t('打开帮助中心细读一遍')}
        </AnimatedButton>
      </footer>
    </ModalOverlay>
  );
}

export function CanvasEntryGuide({ onClose, onOpenTips }: {
  onClose: () => void;
  onOpenTips: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const ownsSettings = useRef(false);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const [index, setIndex] = useState(0);
  const step = CANVAS_ENTRY_GUIDE_STEPS[index];
  const last = index === CANVAS_ENTRY_GUIDE_STEPS.length - 1;
  const [layout, setLayout] = useState<ReturnType<typeof getCanvasGuideLayout> | null>(null);

  const closeOwnedSettings = () => {
    if (!ownsSettings.current) return;
    ownsSettings.current = false;
    setSettingsOpen(false);
  };
  const finish = (keepSettings = false) => {
    if (keepSettings) ownsSettings.current = false;
    else closeOwnedSettings();
    onClose();
  };
  const changeStep = (next: number) => {
    closeOwnedSettings();
    if (CANVAS_ENTRY_GUIDE_STEPS[next].id === 'storage') {
      ownsSettings.current = !useAppStore.getState().settingsOpen;
      setSettingsOpen(true, 'files');
    }
    setIndex(next);
  };
  useDialogFocus(layout !== null, panelRef, () => finish(), { zIndex: 350 });
  useEffect(() => () => {
    if (ownsSettings.current) setSettingsOpen(false);
  }, [setSettingsOpen]);

  useLayoutEffect(() => {
    let frame = 0;
    let disposed = false;
    let scrolled = false;
    let observed: HTMLElement | null = null;
    // 设置弹窗有入场动画；只在最后一步短暂跟随其位置，不常驻逐帧扫描。
    let settleUntil = 0;
    function schedule() { if (!disposed && !frame) frame = requestAnimationFrame(measure); }
    const resize = new ResizeObserver(schedule);
    const discovery = new MutationObserver(schedule);
    function measure() {
      frame = 0;
      if (disposed) return;
      const selector = step.id === 'series'
        ? '[data-onboarding-target="series"], [data-onboarding-target="series-panel"]'
        : `[data-onboarding-target="${step.id}"]`;
      const target = Array.from(document.querySelectorAll<HTMLElement>(selector)).find((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      }) ?? null;
      if (target !== observed) {
        if (observed) resize.unobserve(observed);
        if (target) resize.observe(target);
        observed = target;
      }
      if (target) {
        discovery.disconnect();
        if (step.id === 'storage' && !scrolled) {
          scrolled = true;
          settleUntil = performance.now() + 450;
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
      const next = getCanvasGuideLayout(target?.getBoundingClientRect() ?? null,
        { width: window.innerWidth, height: window.innerHeight },
        { width: 360, height: panelRef.current?.getBoundingClientRect().height ?? 250 }, step.side);
      setLayout((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
      if (performance.now() < settleUntil) schedule();
    }
    if (panelRef.current) resize.observe(panelRef.current);
    discovery.observe(document.body, { childList: true, subtree: true });
    schedule();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      discovery.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [step]);

  return createPortal(
    <div className="canvas-entry-guide" onKeyDown={(event) => event.stopPropagation()}>
      {!layout?.focus && <div className="canvas-entry-guide__shade absolute inset-0" aria-hidden="true" />}
      {layout?.focus && <div className="canvas-entry-guide__focus" style={layout.focus} aria-hidden="true" />}
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className={`canvas-entry-guide__card glass-panel ui-stack p-3 ${layout ? '' : 'invisible'}`} style={layout?.card}>
        <div className="ui-row ui-row--between">
          <span className="ui-badge ui-badge--outline">{t('画布入口引导')} · {index + 1}/{CANVAS_ENTRY_GUIDE_STEPS.length}</span>
          <PopupCloseButton ariaLabel={t('关闭入口引导')} onClick={() => finish()} />
        </div>
        <div role="status" aria-live="polite" className="ui-row">
          <Icon icon={step.icon} width="20" className="shrink-0 text-brand" aria-hidden="true" />
          <h2 id={titleId} className="text-sm font-semibold text-canvas-text">{t(step.title)}</h2>
        </div>
        <p className="text-xs leading-6 text-canvas-text-secondary">{t(step.description)}</p>
        <p className="ui-hint">{t(step.hint)}</p>
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-canvas-border pt-3">
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm mr-auto" onClick={() => {
            closeOwnedSettings();
            onOpenTips();
          }}>{t('更多操作技巧')}</button>
          {index > 0 && <button type="button" className="ui-btn ui-btn--sm" onClick={() => changeStep(index - 1)}>{t('上一步')}</button>}
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => finish()}>{last ? t('稍后设置') : t('跳过')}</button>
          <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" onClick={() => last ? finish(true) : changeStep(index + 1)}>
            {last ? t('开始设置') : index === 2 ? t('查看保存位置') : t('下一步')}
          </button>
        </footer>
      </div>
    </div>, document.body,
  );
}
