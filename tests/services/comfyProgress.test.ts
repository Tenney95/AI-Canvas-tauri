import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComfyProgressSession, parseComfyProgressEvent } from '../../src/services/comfyProgress';
import { useAppStore } from '../../src/store/useAppStore';

class MockWebSocket {
  static CLOSING = 2;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  useAppStore.setState(useAppStore.getInitialState(), true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseComfyProgressEvent', () => {
  it('解析旧版 progress 的真实采样步数', () => {
    expect(parseComfyProgressEvent(JSON.stringify({
      type: 'progress',
      data: { prompt_id: 'prompt-1', node: '12', value: 7, max: 20 },
    }))).toEqual({
      promptId: 'prompt-1',
      stage: 'running',
      executingNodeId: '12',
      value: 7,
      max: 20,
      percent: 35,
    });
  });

  it('解析新版 progress_state 中正在运行的节点', () => {
    expect(parseComfyProgressEvent({
      type: 'progress_state',
      data: {
        prompt_id: 'prompt-2',
        nodes: {
          '4': { state: 'finished', value: 1, max: 1 },
          '8': { state: 'running', value: 3, max: 8, display_node_id: '采样器' },
        },
      },
    })).toEqual({
      promptId: 'prompt-2',
      stage: 'running',
      executingNodeId: '采样器',
      value: 3,
      max: 8,
      percent: 38,
    });
  });

  it('全部节点结束时进入收尾态，不把单节点百分比当成总进度', () => {
    expect(parseComfyProgressEvent({
      type: 'progress_state',
      data: {
        prompt_id: 'prompt-3',
        nodes: {
          '4': { state: 'finished', value: 1, max: 1 },
          '8': { state: 'finished', value: 20, max: 20 },
        },
      },
    })).toEqual({ promptId: 'prompt-3', stage: 'finalizing' });
  });

  it('忽略格式错误、未知类型和无效总量', () => {
    expect(parseComfyProgressEvent('{bad json')).toBeNull();
    expect(parseComfyProgressEvent({ type: 'status', data: {} })).toBeNull();
    expect(parseComfyProgressEvent({
      type: 'progress',
      data: { value: 4, max: 0 },
    })).toEqual({
      promptId: undefined,
      stage: 'running',
      executingNodeId: undefined,
    });
  });
});

describe('createComfyProgressSession', () => {
  it('使用专属 clientId，并在绑定 prompt 后过滤其他任务事件', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    useAppStore.setState({ currentProjectId: 'project-a' });

    const session = createComfyProgressSession({
      baseUrl: 'http://comfy.test:8188',
      projectId: 'project-a',
      nodeId: 'node-1',
    });
    const socket = MockWebSocket.instances[0];
    socket.readyState = 1;
    socket.onopen?.();
    await session.waitUntilReady();
    session.bindPrompt('prompt-1');

    expect(socket.url).toContain('/ws?clientId=ai-canvas-');
    socket.onmessage?.({
      data: JSON.stringify({ type: 'progress', data: { prompt_id: 'prompt-other', value: 9, max: 10 } }),
    });
    expect(useAppStore.getState().comfyNodeProgress['node-1'].stage).toBe('queued');

    socket.onmessage?.({
      data: JSON.stringify({ type: 'progress', data: { prompt_id: 'prompt-1', value: 4, max: 10 } }),
    });
    expect(useAppStore.getState().comfyNodeProgress['node-1']).toMatchObject({
      promptId: 'prompt-1',
      stage: 'running',
      percent: 40,
    });

    session.close();
    expect(useAppStore.getState().comfyNodeProgress['node-1']).toBeUndefined();
  });
});
