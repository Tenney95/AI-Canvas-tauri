import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppearanceUiSnapshot } from '../../src/types';
import { getBuiltinAppearanceTheme } from '../../src/services/appearance/appearanceDefaults';

const driver = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: AppearanceUiSnapshot }) => void>(),
  emitTo: vi.fn(async (_target: string, _event: string, _payload?: unknown) => {}),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: driver.emitTo,
  listen: vi.fn(async (name: string, handler: (event: { payload: AppearanceUiSnapshot }) => void) => {
    driver.listeners.set(name, handler);
    return () => driver.listeners.delete(name);
  }),
}));

import {
  createAppearanceUiSnapshot,
  installStyleGuideAppearanceSource,
  listenForStyleGuideAppearance,
} from '../../src/services/appearance/appearanceWindowSync';

describe('UI Kit appearance synchronization', () => {
  beforeEach(() => {
    driver.listeners.clear();
    driver.emitTo.mockReset();
    vi.stubGlobal('window', { __TAURI__: {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('projects custom UI colors without canvas images or additional configuration', () => {
    const base = getBuiltinAppearanceTheme('standard-dark');
    const theme = {
      ...base,
      mode: 'system' as const,
      ui: {
        ...base.ui, accent: '#c24172', surface: 'transparent',
        button: { ...base.ui.button, radius: 0, primary: { ...base.ui.button.primary, background: '#c24172' } },
      },
      canvas: { ...base.canvas, imageDataUrl: 'data:image/png;base64,fixture' },
    };
    const snapshot = createAppearanceUiSnapshot(theme);
    expect(Object.keys(snapshot).sort()).toEqual(['id', 'mode', 'name', 'ui']);
    expect(snapshot.mode).toBe('system');
    expect(snapshot.ui).toEqual(theme.ui);
    expect(snapshot.ui.button.primary.background).toBe('#c24172');
    expect(JSON.stringify(snapshot)).not.toContain('data:image');
  });

  it('answers opening requests and pushes the latest unsaved draft until disposed', async () => {
    let theme = getBuiltinAppearanceTheme('standard-dark');
    let notify = () => {};
    let ready = () => {};
    const subscribed = new Promise<void>((resolve) => { ready = () => resolve(); });
    const unsubscribe = vi.fn();
    const stop = installStyleGuideAppearanceSource(() => theme, (onChange) => {
      notify = onChange;
      ready();
      return unsubscribe;
    });
    await subscribed;
    try {
      theme = { ...theme, ui: { ...theme.ui, accent: '#c24172', card: '#312431' } };
      notify();
      driver.listeners.get('appearance:style-guide-request')?.({ payload: createAppearanceUiSnapshot(theme) });
      expect(driver.emitTo).toHaveBeenCalledTimes(3);
      expect(driver.emitTo).toHaveBeenLastCalledWith('style-guide', 'appearance:style-guide-sync', createAppearanceUiSnapshot(theme));
      stop();
      expect(unsubscribe).toHaveBeenCalledOnce();
      const calls = driver.emitTo.mock.calls.length;
      notify();
      expect(driver.emitTo).toHaveBeenCalledTimes(calls);
      expect(driver.listeners.size).toBe(0);
    } finally {
      stop();
    }
  });

  it('includes only UI background images in the style guide projection', () => {
    const base = getBuiltinAppearanceTheme('standard-dark');
    const image = { kind: 'image' as const, imageFit: 'cover' as const, imageDataUrl: 'data:image/png;base64,YWJj' };
    const snapshot = createAppearanceUiSnapshot({
      ...base,
      ui: { ...base.ui, surfaceImage: image, button: { ...base.ui.button, normal: { ...base.ui.button.normal, backgroundImage: image } } },
      canvas: { ...base.canvas, imageDataUrl: 'canvas-only-image' },
      node: { ...base.node, backgroundImage: { ...image, imageDataUrl: 'node-only-image' } },
    });
    expect(snapshot.ui.surfaceImage).toEqual(image);
    expect(snapshot.ui.button.normal.backgroundImage).toEqual(image);
    expect(JSON.stringify(snapshot)).not.toContain('canvas-only-image');
    expect(Object.keys(snapshot).sort()).toEqual(['id', 'mode', 'name', 'ui']);
  });

  it('listens before requesting the initial snapshot and releases the receiver on close', async () => {
    let listeningAtRequest = false;
    driver.emitTo.mockImplementation(async (target, event) => {
      if (target === 'main' && event === 'appearance:style-guide-request') {
        listeningAtRequest = driver.listeners.has('appearance:style-guide-sync');
      }
    });
    const onTheme = vi.fn();
    const stop = await listenForStyleGuideAppearance(onTheme);
    try {
      const snapshot = createAppearanceUiSnapshot(getBuiltinAppearanceTheme('standard-light'));
      driver.listeners.get('appearance:style-guide-sync')?.({ payload: snapshot });
      expect(onTheme).toHaveBeenCalledWith(snapshot);
      // The request imports the event transport asynchronously after the listener is registered.
      await vi.waitFor(() => expect(driver.emitTo).toHaveBeenCalledWith('main', 'appearance:style-guide-request'));
      expect(listeningAtRequest).toBe(true);
    } finally {
      stop();
    }
    expect(driver.listeners.size).toBe(0);
  });
});
