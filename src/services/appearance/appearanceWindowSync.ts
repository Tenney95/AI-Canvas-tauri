import type { AppearanceTheme, AppearanceUiSnapshot } from '../../types';
import { STYLE_GUIDE_WINDOW_LABEL } from '../../utils/styleGuideWindow';
import { normalizeAppearanceTheme } from './appearanceDefaults';

const SYNC_EVENT = 'appearance:style-guide-sync';
const REQUEST_EVENT = 'appearance:style-guide-request';

const isTauri = () => typeof window !== 'undefined' && '__TAURI__' in window;

/** 只投影 UI 令牌；预览草稿同样可同步，不必等待配置落盘。 */
export function createAppearanceUiSnapshot(theme: AppearanceTheme): AppearanceUiSnapshot {
  const normalized = normalizeAppearanceTheme(theme);
  return {
    id: normalized.id,
    name: normalized.name,
    mode: normalized.mode,
    ui: normalized.ui,
  };
}

/** 主窗口持有唯一数据源，接收首次请求并推送后续外观变化。 */
export function installStyleGuideAppearanceSource(
  getTheme: () => AppearanceTheme,
  subscribe: (onChange: () => void) => () => void,
): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let unlisten = () => {};
  let unsubscribe = () => {};

  void (async () => {
    const { emitTo, listen } = await import('@tauri-apps/api/event');
    if (disposed) return;
    const publish = () => {
      if (disposed) return;
      void emitTo(STYLE_GUIDE_WINDOW_LABEL, SYNC_EVENT, createAppearanceUiSnapshot(getTheme()))
        .catch(() => console.warn('[AppearanceSync] UI Kit 外观同步失败'));
    };
    const stop = await listen(REQUEST_EVENT, publish);
    if (disposed) {
      stop();
      return;
    }
    unlisten = stop;
    unsubscribe = subscribe(publish);
    publish();
  })().catch(() => console.warn('[AppearanceSync] 外观同步监听启动失败'));

  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    unlisten();
  };
}

export async function requestStyleGuideAppearance(): Promise<void> {
  if (!isTauri()) return;
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo('main', REQUEST_EVENT);
}

/** 先监听再请求当前快照，避免新开窗口丢失首次同步。 */
export async function listenForStyleGuideAppearance(
  onTheme: (theme: AppearanceUiSnapshot) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  const stop = await listen<AppearanceUiSnapshot>(SYNC_EVENT, ({ payload }) => onTheme(payload));
  void requestStyleGuideAppearance()
    .catch(() => console.warn('[AppearanceSync] 当前外观请求失败'));
  return stop;
}
