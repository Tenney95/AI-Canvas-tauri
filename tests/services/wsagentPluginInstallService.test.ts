import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeWsagentPluginInstall } from '../../src/services/wsagentPluginInstallService';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  getState: vi.fn(),
  install: vi.fn(),
  addNode: vi.fn(),
  showToast: vi.fn(),
  getBinding: vi.fn(),
  getAvailableNodes: vi.fn(),
  createNode: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'main', listen: mocks.listen }),
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: mocks.getState } }));
vi.mock('../../src/services/wsagentSharedImages', () => ({
  activeWsagentOwner: (state: { owner: string | null }) => state.owner,
  getWsagentSharedStatus: mocks.getBinding,
}));
vi.mock('../../src/services/canvasViewportService', () => ({
  getCanvasViewportController: () => ({
    getSnapshot: () => ({ visibleBounds: { x: -40, y: 20, width: 840, height: 680 } }),
  }),
}));
vi.mock('../../src/services/plugins/pluginRuntime', () => ({
  getAvailablePluginNodes: mocks.getAvailableNodes,
  createPluginNode: mocks.createNode,
}));

const request = {
  requestId: 'a'.repeat(32),
  manifestText: 'manifest',
  source: 'source',
  uiSource: 'ui',
  projectId: 'wsagent-project',
};
const definition = { pluginId: 'ai-canvas.wsagent', node: { id: 'shared-images' }, revisionDigest: 'revision' };
const node = { id: 'plugin-node', data: {
  type: 'plugin-node', pluginId: definition.pluginId, pluginNodeId: definition.node.id,
} };
let stop: (() => void) | undefined;
let state: ReturnType<typeof buildState>;

function buildState() {
  return {
    owner: 'canvas-work',
    currentProjectId: 'canvas-episode',
    projectExecutionContext: { runtimeEpoch: 'epoch' },
    installedPlugins: [],
    nodes: [] as Array<typeof node>,
    installBundledWsagentPlugin: mocks.install,
    addNode: mocks.addNode,
    showToast: mocks.showToast,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  state = buildState();
  mocks.getState.mockImplementation(() => state);
  mocks.listen.mockResolvedValue(mocks.unlisten);
  mocks.install.mockResolvedValue({ changed: true, revisionDigest: 'revision' });
  mocks.getBinding.mockResolvedValue({ enabled: true, peerProjectId: request.projectId });
  mocks.getAvailableNodes.mockReturnValue([definition]);
  mocks.createNode.mockReturnValue(node);
  mocks.addNode.mockImplementation((added: typeof node) => { state.nodes = [...state.nodes, added]; });
  mocks.invoke.mockResolvedValue(null).mockResolvedValueOnce(request);
});

afterEach(() => {
  stop?.();
  stop = undefined;
});

async function expectReceipt(status: string, requestId = request.requestId) {
  await vi.waitFor(() => expect(mocks.invoke)
    .toHaveBeenCalledWith('wsagent_plugin_install_finish', { requestId, status }));
}

describe('WSAGENT bundled plugin delivery', () => {
  it('takes a startup request, installs the bundle, and adds one node to the paired canvas', async () => {
    stop = observeWsagentPluginInstall();
    await expectReceipt('added');
    expect(mocks.listen).toHaveBeenCalledWith('wsagent-plugin-install-requested', expect.any(Function));
    expect(mocks.install).toHaveBeenCalledWith('manifest', 'source', 'ui');
    expect(mocks.getBinding).toHaveBeenCalledWith('canvas-work');
    expect(mocks.createNode).toHaveBeenCalledWith(definition, { x: 220, y: 270 });
    expect(mocks.addNode).toHaveBeenCalledExactlyOnceWith(node);
  });

  it('acknowledges a later request without duplicating an existing node', async () => {
    stop = observeWsagentPluginInstall();
    await expectReceipt('added');
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(3));
    const next = { ...request, requestId: 'b'.repeat(32) };
    mocks.install.mockResolvedValue({ changed: false, revisionDigest: 'revision' });
    mocks.invoke.mockResolvedValueOnce(next);
    const [, notify] = mocks.listen.mock.calls[0];
    notify();
    await expectReceipt('added', next.requestId);
    expect(mocks.addNode).toHaveBeenCalledTimes(1);
  });

  it('installs without adding a node when the open canvas is paired to another project', async () => {
    mocks.getBinding.mockResolvedValue({ enabled: true, peerProjectId: 'other-wsagent-project' });
    stop = observeWsagentPluginInstall();
    await expectReceipt('installed');
    expect(mocks.addNode).not.toHaveBeenCalled();
  });

  it('skips insertion when the canvas is reopened during pairing lookup', async () => {
    mocks.getBinding.mockImplementation(async () => {
      state = { ...state, projectExecutionContext: { runtimeEpoch: 'reopened' } };
      return { enabled: true, peerProjectId: request.projectId };
    });
    stop = observeWsagentPluginInstall();
    await expectReceipt('installed');
    expect(mocks.addNode).not.toHaveBeenCalled();
  });

  it('reports failed installation without touching the canvas', async () => {
    mocks.install.mockRejectedValue(new Error('plugin registration failed'));
    stop = observeWsagentPluginInstall();
    await expectReceipt('failed');
    expect(mocks.getBinding).not.toHaveBeenCalled();
    expect(mocks.addNode).not.toHaveBeenCalled();
  });
});
