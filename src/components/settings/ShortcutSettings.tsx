/**
 * settings/ShortcutSettings — 快捷键说明子页。
 * 根据操作系统（macOS / Windows）动态展示修饰键符号（⌘/⌃/⌥/⇧ vs Ctrl/Alt/Shift），
 * 列出保存、撤销、复制粘贴、节点创建、画布复位、小地图等快捷键一览。
 */
import { useT } from '../../i18n';
import Select from '../shared/Select';
import { useAppStore } from '../../store/useAppStore';
import { getPromptSubmitShortcutHint, normalizePromptSubmitShortcut, PROMPT_SUBMIT_SHORTCUT_OPTIONS } from '../../utils/promptSubmitShortcut';

const IS_MAC = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent);

function getShortcutList(t: ReturnType<typeof useT>): { action: string; key: string; description?: string }[] {
  const mod = IS_MAC ? '⌘' : 'Ctrl';
  const ctrl = IS_MAC ? '⌃' : 'Ctrl';
  const alt = IS_MAC ? '⌥' : 'Alt';
  const shift = IS_MAC ? '⇧' : 'Shift';
  const del = IS_MAC ? '⌫ Delete' : 'Delete / Backspace';
  return [
    { action: '保存画布', key: `${mod} + S` },
    { action: '撤销', key: `${mod} + Z` },
    { action: '重做', key: `${mod} + Y  /  ${mod} + ${shift} + Z` },
    { action: '复制节点', key: `${mod} + C` },
    { action: '粘贴节点', key: `${mod} + V` },
    {
      action: '拖拽复制空白节点',
      key: `${IS_MAC ? `${mod} / ${ctrl} / ${alt}` : `${mod} / ${alt}`} + ${t('拖拽')}`,
      description: '保留提示词、配置和上游连线，不复制已有内容。画布笔记完整复制；分组和 AI 应用不支持此操作。',
    },
    { action: '删除节点', key: del },
    { action: '重命名节点', key: 'F2' },
    { action: '分组 / 取消分组', key: `${mod} + G` },
    { action: '创建生成节点（文本 / 图像 / 视频 / 音频 / 全景 / 动画）', key: '1–6' },
    { action: '创建源节点（文本 / 图像 / 视频 / 音频 / Markdown）', key: `${alt} + 1–5` },
    { action: '弹出对话框', key: '选中节点+Space' },
    { action: '锁定比例缩放', key: `缩放时按住 ${shift}` },
    { action: '关闭菜单 / 设置', key: 'Escape' },
    { action: '画布复位', key: 'F' },
    { action: '小地图', key: 'M' },
    { action: '资产库', key: 'Tab' },
    { action: '资源搜索窗口', key: `${alt} + Space  /  ${ctrl} + ${shift} + Space` },
    { action: '显示/隐藏吉祥物', key: `${mod} + ${shift} + M` },
  ];
}

export default function ShortcutSettings() {
  const t = useT();
  const shortcut = useAppStore((state) => normalizePromptSubmitShortcut(state.config.promptSubmitShortcut));
  const configHydrated = useAppStore((state) => state.configHydrated);
  const updateConfig = useAppStore((state) => state.updateConfig);
  const saveConfig = useAppStore((state) => state.saveConfig);
  return (
    <div className="space-y-1">
      <p className="text-sm text-canvas-text-muted mb-4">{t('键盘快捷键配置')}</p>
      <div className="flex items-center justify-between gap-3 p-2 rounded-lg hover:bg-canvas-hover">
        <div className="min-w-0 space-y-1 text-sm">
          <span className="text-canvas-text">{t('发送快捷键')}</span>
          <p className="ui-hint">{t('用于画布节点提示词，也可右键发送按钮修改。')} {getPromptSubmitShortcutHint(shortcut)}</p>
        </div>
        <Select value={shortcut} options={PROMPT_SUBMIT_SHORTCUT_OPTIONS} size="sm" className="w-36 shrink-0"
          aria-label={t('发送快捷键')} disabled={!configHydrated}
          onChange={(value) => {
            updateConfig({ promptSubmitShortcut: value });
            void saveConfig({ silent: true }).catch(() => {});
          }} />
      </div>
      {getShortcutList(t).map(({ action, key, description }) => (
        <div key={action} className="flex items-center justify-between gap-4 py-2 px-2.5 rounded-lg hover:bg-canvas-hover">
          <div className="min-w-0 space-y-1 text-sm">
            <span className="text-sm text-canvas-text">{t(action)}</span>
            {description && <p className="ui-hint">{t(description)}</p>}
          </div>
          <kbd className="shrink-0 whitespace-nowrap px-2 py-0.5 bg-canvas-card border border-canvas-border rounded text-[11px] text-canvas-text-secondary font-mono">
            {key}
          </kbd>
        </div>
      ))}
    </div>
  );
}
