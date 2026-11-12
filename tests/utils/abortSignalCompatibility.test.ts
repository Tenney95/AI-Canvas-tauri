import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installAbortSignalCompatibility } from '../../src/utils/abortSignalCompatibility';

const originalAny = Object.getOwnPropertyDescriptor(AbortSignal, 'any');

describe('缺少 AbortSignal.any 的 WebKit', () => {
  beforeEach(() => {
    Object.defineProperty(AbortSignal, 'any', { configurable: true, writable: true, value: undefined });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAny) Object.defineProperty(AbortSignal, 'any', originalAny);
    else Reflect.deleteProperty(AbortSignal, 'any');
  });

  it('保留已有原生方法，重复安装也不替换当前实现', () => {
    const nativeAny = vi.fn();
    Object.defineProperty(AbortSignal, 'any', { configurable: true, writable: true, value: nativeAny });
    installAbortSignalCompatibility();
    installAbortSignalCompatibility();
    expect(AbortSignal.any).toBe(nativeAny);
    expect(nativeAny).not.toHaveBeenCalled();
  });

  it.each([0, 1])('第 %i 个输入取消时传递原始原因，清理全部监听且不取消其他输入', (index) => {
    installAbortSignalCompatibility();
    const controllers = [new AbortController(), new AbortController()];
    const removals = controllers.map(({ signal }) => vi.spyOn(signal, 'removeEventListener'));
    const combined = AbortSignal.any(controllers.map(({ signal }) => signal));
    const onAbort = vi.fn();
    combined.addEventListener('abort', onAbort);
    const reason = new DOMException('原画布已切换', 'AbortError');

    controllers[index].abort(reason);

    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe(reason);
    expect(controllers[1 - index].signal.aborted).toBe(false);
    for (const remove of removals) expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    controllers[1 - index].abort('later');
    expect(onAbort).toHaveBeenCalledOnce();
    expect(combined.reason).toBe(reason);
  });

  it('输入已经取消时立即沿用首个原因，不留下等待监听', () => {
    installAbortSignalCompatibility();
    const first = new AbortController(), second = new AbortController();
    first.abort('first');
    second.abort('second');
    const add = vi.spyOn(first.signal, 'addEventListener');
    expect(AbortSignal.any([first.signal, second.signal]).reason).toBe('first');
    expect(add).not.toHaveBeenCalled();
  });

  it('空输入保持未取消，重复输入只订阅一次，伪造事件不能触发取消', () => {
    installAbortSignalCompatibility();
    expect(AbortSignal.any([]).aborted).toBe(false);
    const source = new AbortController();
    const add = vi.spyOn(source.signal, 'addEventListener');
    const combined = AbortSignal.any([source.signal, source.signal]);
    expect(add).toHaveBeenCalledOnce();
    source.signal.dispatchEvent(new Event('abort'));
    expect(combined.aborted).toBe(false);
    source.abort();
    expect(combined.reason).toBe(source.signal.reason);
  });
});
