/**
 * 原生文件拖放坐标转为 DOM client 坐标。
 * 当前锁定的 Wry 0.55.1 在 macOS 直接返回 AppKit 逻辑点，其他桌面端返回物理像素。
 * 不适用于 cursorPosition / innerPosition 等明确返回物理像素的窗口 API。
 */
export function nativeDropClientPosition(position: { x: number; y: number }): { x: number; y: number } {
  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');
  const scale = mac ? 1 : window.devicePixelRatio || 1;
  return { x: position.x / scale, y: position.y / scale };
}
