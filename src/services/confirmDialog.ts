/**
 * confirmDialog — 统一的确认对话框入口。
 *
 * tauri-plugin-dialog 2.7.1 注入的初始化脚本把 window.confirm 覆盖成了
 * 调用 `plugin:dialog|confirm` 的 async 函数，但该插件的 generate_handler!
 * 只注册了 open / save / message，没有 confirm，于是每次调用都抛
 * "dialog.confirm not allowed. Command not found"。
 *
 * 更隐蔽的是它返回 Promise：同步写法 `if (!window.confirm(...))` 里的
 * !Promise 恒为 false，等于不询问就往下执行破坏性操作。
 *
 * 这里改调插件导出的 confirm()，它内部走 plugin:dialog|message + OkCancel，
 * 命令是存在的。非 Tauri 环境退回浏览器原生 confirm。
 */
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog';
import { isTauriEnv } from './fileService';

export interface ConfirmActionOptions {
  title?: string;
  kind?: 'info' | 'warning' | 'error';
  okLabel?: string;
  cancelLabel?: string;
}

export async function confirmAction(
  message: string,
  options: ConfirmActionOptions = {},
): Promise<boolean> {
  if (!isTauriEnv()) return window.confirm(message);
  return tauriConfirm(message, {
    title: options.title ?? '请确认',
    kind: options.kind ?? 'warning',
    okLabel: options.okLabel ?? '确定',
    cancelLabel: options.cancelLabel ?? '取消',
  });
}
