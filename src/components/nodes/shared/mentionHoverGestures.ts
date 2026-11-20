/** All mention editors in one window share the pointer state, including native drag cancellation. */
type Listener = (event: Event) => void;
const windows = new WeakMap<Window, { listeners: Set<Listener>; suppressed: boolean; dispose(): void }>();

export function mentionHoverSuppressed(view: Window) {
  return windows.get(view)?.suppressed ?? false;
}

export function subscribeMentionHoverGestures(view: Window, listener: Listener) {
  let gestures = windows.get(view);
  if (!gestures) {
    const events = ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'dragstart', 'dragend', 'drop', 'blur', 'resize', 'scroll', 'keydown'];
    const capture = (type: string) => !['blur', 'resize', 'keydown'].includes(type);
    let nativeDragging = false;
    const entry = { listeners: new Set<Listener>(), suppressed: false, dispose() {
      for (const type of events) view.removeEventListener(type, handle, capture(type));
    } };
    const handle = (event: Event) => {
      switch (event.type) {
        case 'pointermove':
          if ((event as PointerEvent).buttons === 0 && !nativeDragging) entry.suppressed = false;
          return;
        case 'pointerup':
          entry.suppressed = nativeDragging || (event as PointerEvent).buttons !== 0;
          return;
        case 'pointerdown': entry.suppressed = true; break;
        case 'dragstart': nativeDragging = entry.suppressed = true; break;
        case 'pointercancel': entry.suppressed = nativeDragging; break;
        case 'drop':
        case 'dragend':
        case 'blur': nativeDragging = entry.suppressed = false; break;
        case 'keydown': if ((event as KeyboardEvent).key !== 'Escape') return; break;
      }
      for (const notify of entry.listeners) notify(event);
    };
    for (const type of events) view.addEventListener(type, handle, capture(type));
    windows.set(view, entry);
    gestures = entry;
  }
  const current = gestures;
  current.listeners.add(listener);
  return () => {
    if (!current.listeners.delete(listener) || current.listeners.size) return;
    current.dispose();
    windows.delete(view);
  };
}
