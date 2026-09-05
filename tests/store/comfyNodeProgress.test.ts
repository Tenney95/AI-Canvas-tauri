import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
});

describe('ComfyUI 节点运行时进度', () => {
  it('旧请求不能覆盖或清除同一节点的新请求', () => {
    const store = useAppStore.getState();
    store.beginComfyNodeProgress({
      projectId: 'project-a',
      nodeId: 'node-1',
      requestId: 'request-old',
      clientId: 'client-old',
      stage: 'connecting',
    });
    useAppStore.getState().beginComfyNodeProgress({
      projectId: 'project-a',
      nodeId: 'node-1',
      requestId: 'request-new',
      clientId: 'client-new',
      stage: 'queued',
    });

    useAppStore.getState().updateComfyNodeProgress('node-1', 'request-old', {
      stage: 'running',
      percent: 90,
    });
    useAppStore.getState().clearComfyNodeProgress('node-1', 'request-old');

    expect(useAppStore.getState().comfyNodeProgress['node-1']).toMatchObject({
      requestId: 'request-new',
      stage: 'queued',
    });
    expect(useAppStore.getState().comfyNodeProgress['node-1'].percent).toBeUndefined();
  });

  it('当前请求可以更新并在完成后清理', () => {
    useAppStore.getState().beginComfyNodeProgress({
      projectId: 'project-a',
      nodeId: 'node-1',
      requestId: 'request-1',
      clientId: 'client-1',
      stage: 'connecting',
    });
    useAppStore.getState().updateComfyNodeProgress('node-1', 'request-1', {
      promptId: 'prompt-1',
      stage: 'running',
      value: 5,
      max: 10,
      percent: 50,
    });

    expect(useAppStore.getState().comfyNodeProgress['node-1']).toMatchObject({
      promptId: 'prompt-1',
      stage: 'running',
      percent: 50,
    });

    useAppStore.getState().clearComfyNodeProgress('node-1', 'request-1');
    expect(useAppStore.getState().comfyNodeProgress['node-1']).toBeUndefined();
  });
});
