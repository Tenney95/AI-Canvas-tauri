import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { createServer as createViteServer } from 'vite';
import viteConfig from '../../vite.config';
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
  vi.unstubAllEnvs();
  vi.useRealTimers();
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
  it.each([
    { dev: true, baseUrl: 'http://127.0.0.1:8188', page: 'http://localhost:1420', expected: 'ws://localhost:1420/api/comfyui/ws' },
    { dev: true, baseUrl: 'http://localhost:8188', page: 'https://localhost:1420', expected: 'wss://localhost:1420/api/comfyui/ws' },
    { dev: true, baseUrl: 'https://comfy.test/prefix', page: 'http://localhost:1420', expected: 'wss://comfy.test/prefix/ws' },
    { dev: true, baseUrl: 'http://127.0.0.1:8288', page: 'http://localhost:1420', expected: 'ws://127.0.0.1:8288/ws' },
    { dev: false, baseUrl: 'http://127.0.0.1:8188', page: 'http://tauri.localhost', expected: 'ws://127.0.0.1:8188/ws' },
  ])('进度连接选路 $baseUrl / dev=$dev', ({ dev, baseUrl, page, expected }) => {
    vi.stubEnv('DEV', dev);
    vi.stubGlobal('window', { location: new URL(page), __TAURI__: {} });
    vi.stubGlobal('WebSocket', MockWebSocket);
    const session = createComfyProgressSession({ baseUrl, projectId: 'p1', nodeId: 'n1' });
    try {
      expect(MockWebSocket.instances[0].url).toBe(`${expected}?clientId=${session.clientId}`);
    } finally {
      session.close();
    }
  });

  it('新节点开始和整个任务收尾时清除上一节点的百分比', () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const session = createComfyProgressSession({ baseUrl: 'http://comfy.test', projectId: 'p1', nodeId: 'n1' });
    const socket = MockWebSocket.instances[0];
    session.bindPrompt('prompt-1');
    const emit = (type: string, data: Record<string, unknown>) => socket.onmessage?.({
      data: JSON.stringify({ type, data: { prompt_id: 'prompt-1', ...data } }),
    });
    try {
      emit('progress', { node: '12', value: 8, max: 8 });
      expect(useAppStore.getState().comfyNodeProgress.n1.percent).toBe(100);
      emit('executing', { node: '13' });
      expect(useAppStore.getState().comfyNodeProgress.n1.percent).toBeUndefined();
      emit('progress', { node: '13', value: 1, max: 4 });
      expect(useAppStore.getState().comfyNodeProgress.n1.percent).toBe(25);
      emit('execution_success', {});
      expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({ stage: 'finalizing', percent: undefined });
    } finally {
      session.close();
    }
  });

  it('提交响应晚于真实进度时，绑定 prompt 不退回排队或串入其他任务', () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const session = createComfyProgressSession({ baseUrl: 'http://comfy.test', projectId: 'p1', nodeId: 'n1' });
    const socket = MockWebSocket.instances[0];
    try {
      for (const [prompt_id, value] of [['prompt-1', 3], ['other', 7]] as const) {
        socket.onmessage?.({ data: JSON.stringify({ type: 'progress', data: { prompt_id, node: '12', value, max: 8 } }) });
      }
      session.bindPrompt('prompt-1');
      expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({ promptId: 'prompt-1', stage: 'running', percent: 38 });
    } finally {
      session.close();
    }
  });

  it('断线后复用 clientId 重连，关闭会话后不再更新或重连', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const session = createComfyProgressSession({ baseUrl: 'http://comfy.test', projectId: 'p1', nodeId: 'n1' });
    const first = MockWebSocket.instances[0];
    first.readyState = 1;
    first.onopen?.();
    session.bindPrompt('prompt-1');
    first.onmessage?.({ data: JSON.stringify({ type: 'progress', data: { prompt_id: 'prompt-1', value: 2, max: 8 } }) });
    first.close();
    expect(useAppStore.getState().comfyNodeProgress.n1.percent).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    try {
      expect(MockWebSocket.instances).toHaveLength(2);
      const second = MockWebSocket.instances[1];
      expect(second.url).toBe(first.url);
      second.readyState = 1;
      second.onopen?.();
      second.onmessage?.({ data: JSON.stringify({ type: 'progress', data: { prompt_id: 'prompt-1', value: 4, max: 8 } }) });
      expect(useAppStore.getState().comfyNodeProgress.n1.percent).toBe(50);
      first.onmessage?.({ data: JSON.stringify({ type: 'progress', data: { prompt_id: 'prompt-1', value: 8, max: 8 } }) });
      expect(useAppStore.getState().comfyNodeProgress.n1.percent).toBe(50);
    } finally {
      session.close();
    }
    await vi.advanceTimersByTimeAsync(10000);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(useAppStore.getState().comfyNodeProgress.n1).toBeUndefined();
  });

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

  it('连续连接失败最多重连三次，已中止的任务不再绑定进度', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const controller = new AbortController();
    const session = createComfyProgressSession({ baseUrl: 'http://comfy.test', projectId: 'p1', nodeId: 'n1', signal: controller.signal });
    for (let index = 0; index < 4; index += 1) {
      MockWebSocket.instances[index].onerror?.();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(MockWebSocket.instances).toHaveLength(4);
    controller.abort();
    session.bindPrompt('late-prompt');
    await vi.advanceTimersByTimeAsync(10000);
    expect(MockWebSocket.instances).toHaveLength(4);
    expect(useAppStore.getState().comfyNodeProgress.n1).toBeUndefined();
  });
});

it('真实 Vite 代理保留 Host/Origin，传回采样事件并继续拒绝跨站连接', async () => {
  const received: Array<{ host?: string; origin?: string; url?: string }> = [];
  const sockets = new Set<Socket>();
  const backend = createServer();
  const event = JSON.stringify({ type: 'progress', data: { prompt_id: 'p1', node: '12', value: 3, max: 8 } });
  backend.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  backend.on('upgrade', (req, socket) => {
    received.push({ host: req.headers.host, origin: req.headers.origin, url: req.url });
    // 复现 ComfyUI origin_only_middleware 的本地 Host/Origin 校验。
    if (!req.headers.origin || new URL(req.headers.origin).host !== req.headers.host) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    const headers = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
    socket.write(Buffer.concat([Buffer.from(headers), Buffer.from([0x81, Buffer.byteLength(event)]), Buffer.from(event)]));
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const backendPort = (backend.address() as { port: number }).port;
  const proxy = viteConfig.server?.proxy?.['/api/comfyui/ws'];
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  try {
    expect(proxy).toBeTypeOf('object');
    if (!proxy || typeof proxy === 'string') throw new Error('缺少 ComfyUI WebSocket 代理');
    vite = await createViteServer({
      configFile: false, appType: 'custom', logLevel: 'silent',
      server: {
        host: '127.0.0.1', port: 0, hmr: false, watch: null,
        proxy: { '/api/comfyui/ws': { ...proxy, target: `http://127.0.0.1:${backendPort}` } },
      },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await vite.listen();
    const port = (vite.httpServer?.address() as { port: number }).port;
    const connect = (origin: string) => new Promise<{ status: number; frame?: Buffer }>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port, path: '/api/comfyui/ws?clientId=test-client',
        headers: {
          Host: 'localhost:1420', Origin: origin, Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
        },
      });
      req.setTimeout(3000, () => req.destroy(new Error('WebSocket 代理连接超时')));
      req.on('error', reject);
      req.on('response', (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      });
      req.on('upgrade', (response, socket, head) => {
        const complete = (frame: Buffer) => {
          socket.destroy();
          resolve({ status: response.statusCode ?? 0, frame });
        };
        if (head.length) complete(head);
        else socket.once('data', complete);
      });
      req.end();
    });

    const accepted = await connect('http://localhost:1420');
    expect(accepted.status).toBe(101);
    expect(parseComfyProgressEvent(accepted.frame?.subarray(2).toString())).toMatchObject({ value: 3, max: 8, percent: 38 });
    expect(received[0]).toEqual({ host: 'localhost:1420', origin: 'http://localhost:1420', url: '/ws?clientId=test-client' });
    expect((await connect('https://untrusted.example')).status).toBe(403);
  } finally {
    for (const socket of sockets) socket.destroy();
    await vite?.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});
