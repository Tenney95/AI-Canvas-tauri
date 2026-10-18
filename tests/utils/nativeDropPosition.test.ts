import { afterEach, expect, it, vi } from 'vitest';
import { nativeDropClientPosition } from '../../src/utils/nativeDropPosition';

afterEach(() => vi.unstubAllGlobals());

it.each([
  ['MacIntel', 2, 150],
  ['MacIntel', 1, 150],
  ['Win32', 2, 75],
  ['Win32', 1.5, 100],
  ['Linux x86_64', 2, 75],
])('%s 在倍率 %s 下将原生落点转换为 client 坐标', (platform, ratio, expected) => {
  vi.stubGlobal('navigator', { platform });
  vi.stubGlobal('window', { devicePixelRatio: ratio });
  expect(nativeDropClientPosition({ x: 150, y: 300 })).toEqual({ x: expected, y: expected * 2 });
});

it('每次读取当前屏幕倍率，支持窗口移到不同缩放的显示器', () => {
  vi.stubGlobal('navigator', { platform: 'Win32' });
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  expect(nativeDropClientPosition({ x: 300, y: 300 })).toEqual({ x: 300, y: 300 });
  window.devicePixelRatio = 2;
  expect(nativeDropClientPosition({ x: 300, y: 300 })).toEqual({ x: 150, y: 150 });
});
