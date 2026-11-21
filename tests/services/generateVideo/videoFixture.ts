import { afterEach, beforeEach, vi, type Mock } from 'vitest';
import { useAppStore } from '../../../src/store/useAppStore';

export function setupVideoFixture(executeVideo: Mock) {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    executeVideo.mockReset();
    executeVideo.mockResolvedValue({ url: 'https://cdn.example/result.mp4' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
}
