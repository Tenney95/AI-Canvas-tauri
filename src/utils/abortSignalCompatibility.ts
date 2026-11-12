/** 较旧的 WKWebView / WebKitGTK 没有 any()；所有应用窗口在挂载前统一补齐。 */
export function installAbortSignalCompatibility(): void {
  if (typeof AbortSignal.any === 'function') return;

  Object.defineProperty(AbortSignal, 'any', {
    configurable: true,
    writable: true,
    value(signals: AbortSignal[]): AbortSignal {
      const controller = new AbortController();
      const inputs = [...new Set(signals)];
      const alreadyAborted = inputs.find((signal) => signal.aborted);
      if (alreadyAborted) {
        controller.abort(alreadyAborted.reason);
        return controller.signal;
      }

      const abort = () => {
        const source = inputs.find((signal) => signal.aborted);
        if (!source) return;
        for (const signal of inputs) signal.removeEventListener('abort', abort);
        controller.abort(source.reason);
      };
      for (const signal of inputs) signal.addEventListener('abort', abort);
      return controller.signal;
    },
  });
}
