import { afterEach, beforeEach, vi, type Mock } from 'vitest';
import { useAppStore } from '../../../src/store/useAppStore';

export function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function setupTransportFixture(corsSafeFetch: Mock) {
  beforeEach(() => {
    corsSafeFetch.mockReset();
    corsSafeFetch.mockRejectedValue(new Error('未模拟的模型网络请求'));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('未模拟的直接网络请求'));
    useAppStore.setState(useAppStore.getInitialState(), true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
}
