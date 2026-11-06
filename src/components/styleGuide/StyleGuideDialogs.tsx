/**
 * StyleGuideDialogs — 提供弹窗样式示例界面与交互。
 */
import { useCallback, useState, type FormEvent } from 'react';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import Select from '../shared/Select';
import NumberStepper from '../shared/NumberStepper';

const EXAMPLES = [
  { kind: 'basic', label: '普通弹窗', title: '普通弹窗示例' },
  { kind: 'form', label: '表单弹窗', title: '编辑示例配置' },
  { kind: 'glass', label: '磨砂小弹窗', title: '磨砂小弹窗示例' },
  { kind: 'confirm', label: '确认弹窗', title: '确认此操作？' },
  { kind: 'long', label: '长内容弹窗', title: '长内容滚动示例' },
] as const;

type DialogKind = typeof EXAMPLES[number]['kind'];

export default function StyleGuideDialogs() {
  const [isOpen, setIsOpen] = useState(false);
  const [kind, setKind] = useState<DialogKind>('basic');
  const [closeOnBackdrop, setCloseOnBackdrop] = useState(true);
  const [draggable, setDraggable] = useState(false);
  const [backdropBlur, setBackdropBlur] = useState(true);
  const [name, setName] = useState('我的示例配置');
  const [description, setDescription] = useState('编辑名称与说明，查看表单、按钮和焦点交互。');
  const [backgroundKind, setBackgroundKind] = useState('color');
  const [count, setCount] = useState(40);
  const [result, setResult] = useState('选择一个样例打开弹窗。');
  const example = EXAMPLES.find((item) => item.kind === kind)!;
  const isForm = kind === 'form' || kind === 'glass';
  const close = useCallback(() => setIsOpen(false), []);

  const finish = () => {
    setResult(kind === 'confirm' ? '已确认示例操作。' : '已完成弹窗示例。');
    close();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) return;
    setResult(`已记录表单示例：${name.trim()}`);
    close();
  };

  return (
    <>
      <div className="ui-stack">
        <div className="ui-row ui-row--loose">
          {EXAMPLES.map((item) => (
            <button
              key={item.kind}
              type="button"
              className="ui-btn ui-btn--secondary"
              onClick={() => { setKind(item.kind); setIsOpen(true); }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="ui-row ui-row--loose">
          <div className="ui-row ui-row--tight">
            <input id="sg-dialog-backdrop" type="checkbox" className="ui-checkbox" checked={closeOnBackdrop} onChange={(event) => setCloseOnBackdrop(event.target.checked)} />
            <label htmlFor="sg-dialog-backdrop">点击遮罩关闭</label>
          </div>
          <div className="ui-row ui-row--tight">
            <input id="sg-dialog-draggable" type="checkbox" className="ui-checkbox" checked={draggable} onChange={(event) => setDraggable(event.target.checked)} />
            <label htmlFor="sg-dialog-draggable">标题栏拖动</label>
          </div>
          <div className="ui-row ui-row--tight">
            <input id="sg-dialog-blur" type="checkbox" className="ui-checkbox" checked={backdropBlur} onChange={(event) => setBackdropBlur(event.target.checked)} />
            <label htmlFor="sg-dialog-blur">背景模糊</label>
          </div>
        </div>
        <p className="ui-hint">Tab / Shift+Tab 在弹窗内切换焦点，Esc 关闭后返回入口按钮；演示结果保留在本分区。</p>
        <p className="ui-hint" role="status" aria-live="polite">{result}</p>
      </div>

      <ModalOverlay
        isOpen={isOpen}
        onClose={close}
        ariaLabel={example.title}
        closeOnBackdrop={closeOnBackdrop}
        draggable={draggable}
        backdropBlur={backdropBlur}
        className={`${kind === 'glass' ? '' : 'ui-dialog-surface'} max-h-[calc(100vh-32px)] ${kind === 'long' ? 'w-[min(640px,calc(100vw-32px))]' : 'w-[min(480px,calc(100vw-32px))]'}`}
      >
        <header data-modal-drag-handle className={`ui-card__header shrink-0 ${draggable ? 'cursor-grab' : ''}`}>
          <div className="min-w-0 flex-1">
            <h3 className="ui-card__title">{example.title}</h3>
            <p className="ui-card__desc">{draggable ? '拖动标题栏移动弹窗' : '标题、内容与底部操作分层展示'}</p>
          </div>
          <div className="ui-card__header-actions shrink-0">
            <PopupCloseButton onClick={close} ariaLabel="关闭示例弹窗" />
          </div>
        </header>

        <div className="ui-card__body ui-scroll min-h-0">
          {kind === 'basic' && (
            <div className="ui-stack">
              <p>这是应用共用弹窗的实际容器，用于展示普通说明、设置内容或操作结果。</p>
              <div className="ui-alert ui-alert--info">
                <div className="ui-alert__body">切换 UI Kit 的明暗预览或“跟随外观”，可检查弹窗与按钮配色。</div>
              </div>
            </div>
          )}
          {isForm && (
            <form id="sg-dialog-form" className="ui-stack" onSubmit={submit}>
              <label className="ui-field">
                <span className="ui-label">示例名称</span>
                <input className="ui-input" value={name} onChange={(event) => setName(event.target.value)} required placeholder="请输入名称" />
                <span className="ui-hint">名称不能为空，按 Enter 可提交示例。</span>
              </label>
              <label className="ui-field">
                <span className="ui-label">说明</span>
                <textarea className="ui-textarea" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
              </label>
              <div className="ui-field">
                <label className="ui-label" htmlFor="sg-dialog-count">次数</label>
                <div className="ui-row">
                  <NumberStepper id="sg-dialog-count" value={count} onChange={setCount} min={0} max={100} />
                  <output className="text-xs tabular-nums text-canvas-text-secondary">已提交值：{count}</output>
                </div>
                <span className="ui-hint">编辑数值后，首次 Esc 取消草稿并保留弹窗，再按 Esc 关闭弹窗。示例值仅保留在本窗口。</span>
              </div>
              <div className="ui-field">
                <label className="ui-label" htmlFor="sg-dialog-background">背景类型</label>
                <Select id="sg-dialog-background" value={backgroundKind} onChange={setBackgroundKind}
                  options={[{ value: 'color', label: '纯色' }, { value: 'image', label: '上传图片' }]} />
                <span className="ui-hint">菜单可越过滚动区和弹窗边界显示；Esc 先收起菜单，再关闭弹窗。</span>
              </div>
              {kind === 'glass' && (
                <div className="ui-card ui-stack p-2">
                  <h4 className="text-xs font-medium text-canvas-text">内部内容分组</h4>
                  <p className="ui-hint">卡片、下拉与数字输入共用底色，文字与交互状态保持清晰层次。</p>
                  <label className="ui-field">
                    <span className="ui-label">禁用输入</span>
                    <input className="ui-input" value="当前使用默认配置" disabled />
                  </label>
                </div>
              )}
            </form>
          )}
          {kind === 'confirm' && (
            <div className="ui-stack">
              <div className="ui-alert ui-alert--warning">
                <div className="ui-alert__body">用于查看需要明确确认的操作，以及取消与危险操作按钮的布局。</div>
              </div>
              <p>点击“确认操作”后，本分区将记录示例结果。</p>
            </div>
          )}
          {kind === 'long' && (
            <div className="ui-stack">
              <p>缩窄或降低窗口高度，内容区可滚动，标题和底部操作保持可见。</p>
              <div className="ui-list">
                {Array.from({ length: 18 }, (_, index) => (
                  <div key={index} className="ui-list__item">
                    <span>第 {index + 1} 项 · 这是一段用于检查弹窗内容滚动、文本换行和窗口边界的示例说明。</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <footer className="ui-card__footer shrink-0">
          <div className="ui-card__footer-actions">
            <button type="button" className="ui-btn ui-btn--ghost" onClick={close}>取消</button>
            <button
              type={isForm ? 'submit' : 'button'}
              form={isForm ? 'sg-dialog-form' : undefined}
              className={`ui-btn ${kind === 'confirm' ? 'ui-btn--danger' : 'ui-btn--primary'}`}
              disabled={isForm && !name.trim()}
              onClick={isForm ? undefined : finish}
            >
              {isForm ? '保存示例' : kind === 'confirm' ? '确认操作' : '完成'}
            </button>
          </div>
        </footer>
      </ModalOverlay>
    </>
  );
}
