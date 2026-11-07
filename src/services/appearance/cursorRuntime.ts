/** 原生 SVG 光标的按压反馈，仅在窗口内存和根元素上保留状态。 */
const CURSOR_SOURCES = import.meta.glob<string>('../../assets/cursors/{dark,light}/*.svg', {
  query: '?raw', import: 'default', eager: true,
});
const PRESS_SCALE = 0.94;
const HOTSPOTS: Record<string, readonly [number, number]> = {
  default: [3, 9], pointer: [13, 7], help: [3, 9],
};

// 扩展视框使图形围绕点击热点缩小，保留 SVG 的 32px 自然尺寸和原生热点。
const PRESSED_CURSORS = Object.entries(CURSOR_SOURCES).map(([path, source]) => {
  const parts = path.split('/');
  const theme = parts.at(-2)!;
  const name = parts.at(-1)!.slice(0, -4);
  const [hx, hy] = HOTSPOTS[name] ?? [15, 15];
  const inset = 1 / PRESS_SCALE - 1;
  const viewBox = [-hx * inset, -hy * inset, 32 / PRESS_SCALE, 32 / PRESS_SCALE]
    .map((value) => value.toFixed(6)).join(' ');
  const svg = source.replace(/\bviewBox="[^"]*"/, `viewBox="${viewBox}"`);
  return [
    `--cursor-pressed-${theme}-${name}`,
    `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hx} ${hy}, ${name}`,
  ] as const;
});

export function installCursorPressFeedback(): () => void {
  const root = document.documentElement;
  const controller = new AbortController();
  const options = { capture: true, passive: true, signal: controller.signal };
  const passiveOptions = { passive: true, signal: controller.signal };
  let pressed = false;

  root.removeAttribute('data-cursor-pressed');
  for (const [property, value] of PRESSED_CURSORS) root.style.setProperty(property, value);

  const setPressed = (next: boolean) => {
    if (pressed === next) return;
    pressed = next;
    root.toggleAttribute('data-cursor-pressed', next);
  };
  const reset = () => setPressed(false);
  const sync = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') setPressed((event.buttons & 7) !== 0);
  };
  const cancel = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') reset();
  };
  const leave = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.relatedTarget === null) reset();
  };
  const visibility = () => { if (document.hidden) reset(); };

  window.addEventListener('pointerdown', sync, options);
  window.addEventListener('pointerup', sync, options);
  // 组合鼠标按键的中间变化也通过 pointermove 上报；移回窗口时同步真实状态。
  window.addEventListener('pointermove', sync, options);
  window.addEventListener('pointercancel', cancel, options);
  window.addEventListener('pointerout', leave, options);
  window.addEventListener('dragstart', reset, options);
  window.addEventListener('dragend', reset, options);
  window.addEventListener('drop', reset, options);
  window.addEventListener('blur', reset, passiveOptions);
  window.addEventListener('pagehide', reset, passiveOptions);
  document.addEventListener('visibilitychange', visibility, passiveOptions);

  return () => {
    controller.abort();
    root.removeAttribute('data-cursor-pressed');
    for (const [property] of PRESSED_CURSORS) root.style.removeProperty(property);
  };
}
