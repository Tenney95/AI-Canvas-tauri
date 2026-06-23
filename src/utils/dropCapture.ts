/**
 * dropCapture — 全局「外部文件拖放」占用标记
 *
 * Tauri 的 `tauri://drag-drop` 是窗口级事件，画布与全屏编辑器会同时收到。
 * 当某个全屏编辑器（如合成器）需要独占外部拖放时，置位此标记，
 * 画布的拖放处理器据此跳过建节点，避免在弹层后面误建节点。
 */
let captured = false;

export function setExternalDropCaptured(value: boolean) {
  captured = value;
}

export function isExternalDropCaptured() {
  return captured;
}
