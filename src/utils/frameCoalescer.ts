/** frameCoalescer — 每帧只处理最近一次预览输入，结束手势时可丢弃待执行输入。 */
export function createFrameCoalescer<T>(run: (value: T) => void) {
  let frame: number | undefined;
  let pending: { value: T } | undefined;
  return {
    schedule(value: T) {
      pending = { value };
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const latest = pending;
        pending = undefined;
        if (latest) run(latest.value);
      });
    },
    cancel() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      pending = undefined;
    },
  };
}
