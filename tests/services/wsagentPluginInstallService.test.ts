import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observePluginDelivery } from '../../src/services/plugins/pluginDeliveryService';
import { wsagentPluginPlacement } from '../../src/services/wsagentPluginInstallService';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn(), getState: vi.fn(), install: vi.fn(),
  addNode: vi.fn(), showToast: vi.fn(), getBinding: vi.fn(), getAvailableNodes: vi.fn(),
  createNode: vi.fn(), confirm: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main', listen: mocks.listen }) }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: mocks.getState } }));
vi.mock('../../src/services/confirmDialog', () => ({ confirmAction: mocks.confirm }));
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

const projectId = 'wsagent-project';
const manifestText = (id: string) => JSON.stringify({
  id, apiVersion: 2, runtime: 'javascript', name: 'Local Connector', version: '0.1.0',
  category: 'workflow', entry: 'main.js', permissions: ['node.read', 'node.write'],
  contributes: { nodeTools: [{
    id: 'example-action', title: 'Run', placements: ['node-context-menu'], nodeTypes: ['ai-text'],
    inputFields: ['output'], output: { mode: 'update-current', fields: ['output'] },
  }] },
});
const request = { requestId: 'a'.repeat(32), manifestText: manifestText('ai-canvas.wsagent'), source: 'source', trustedPublisher: 'WSAGENT' };
const definition = { pluginId: 'ai-canvas.wsagent', node: { id: 'shared-images' }, revisionDigest: 'revision' };
const node = { id: 'plugin-node', data: { type: 'plugin-node', pluginId: definition.pluginId, pluginNodeId: definition.node.id } };
let stop: (() => void) | undefined;
let state: ReturnType<typeof buildState>;
let pending: Array<Omit<typeof request, 'trustedPublisher'> & { trustedPublisher?: string }>;
let deliveryCurrent: boolean;

function buildState() {
  return {
    owner: 'canvas-work', currentProjectId: 'canvas-episode',
    projectExecutionContext: { runtimeEpoch: 'epoch' },
    installedPlugins: [], nodes: [] as Array<typeof node>, installDeliveredPluginBundle: mocks.install,
    addNode: mocks.addNode, showToast: mocks.showToast,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  state = buildState();
  pending = [request];
  deliveryCurrent = true;
  mocks.getState.mockImplementation(() => state);
  mocks.listen.mockResolvedValue(mocks.unlisten);
  mocks.install.mockImplementation(async (_manifest, _source, options) => {
    await options.assertDeliveryCurrent();
    return { changed: true, revisionDigest: 'revision' };
  });
  mocks.getBinding.mockResolvedValue({ enabled: true, peerProjectId: projectId });
  mocks.getAvailableNodes.mockReturnValue([definition]);
  mocks.createNode.mockReturnValue(node);
  mocks.addNode.mockImplementation((added: typeof node) => { state.nodes = [...state.nodes, added]; });
  mocks.invoke.mockImplementation(async (command) => {
    if (command === 'plugin_delivery_take') return pending.shift() ?? null;
    if (command === 'plugin_delivery_check') return deliveryCurrent;
    if (command === 'wsagent_plugin_install_project') return projectId;
    return null;
  });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
});

async function expectReceipt(status: string, requestId = request.requestId) {
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('plugin_delivery_finish', {
    requestId, status, sessionId: expect.any(String),
  }));
}

function observe() {
  stop = observePluginDelivery([wsagentPluginPlacement]);
}

describe('desktop plugin package delivery', () => {
  it('installs a trusted package and lets its integration add one node to the paired canvas', async () => {
    observe();
    await expectReceipt('added');
    expect(mocks.listen).toHaveBeenCalledWith('plugin-delivery-requested', expect.any(Function));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith('wsagent_plugin_install_project', { requestId: request.requestId });
    expect(mocks.getBinding).toHaveBeenCalledWith('canvas-work');
    expect(mocks.createNode).toHaveBeenCalledWith(definition, { x: 220, y: 270 });
    expect(mocks.addNode).toHaveBeenCalledExactlyOnceWith(node);
  });

  it('acknowledges a later request without duplicating an existing node', async () => {
    observe();
    await expectReceipt('added');
    const next = { ...request, requestId: 'b'.repeat(32) };
    mocks.install.mockResolvedValue({ changed: false, revisionDigest: 'revision' });
    pending.push(next);
    const [, notify] = mocks.listen.mock.calls[0];
    notify();
    await expectReceipt('added', next.requestId);
    expect(mocks.addNode).toHaveBeenCalledTimes(1);
  });

  it('installs a confirmed package from another publisher using the same entry point', async () => {
    pending = [{ ...request, manifestText: manifestText('example.editor'), trustedPublisher: undefined }];
    mocks.confirm.mockResolvedValue(true);
    observe();
    await expectReceipt('installed');
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.install).toHaveBeenCalledWith(manifestText('example.editor'), 'source', expect.objectContaining({
      expectedSourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u), reviewedRevision: null,
    }));
    expect(mocks.getBinding).not.toHaveBeenCalled();
    expect(mocks.addNode).not.toHaveBeenCalled();
  });

  it('does not treat a familiar plugin ID as package trust', async () => {
    pending = [{ ...request, trustedPublisher: undefined }];
    mocks.confirm.mockResolvedValue(false);
    observe();
    await expectReceipt('cancelled');
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.addNode).not.toHaveBeenCalled();
  });

  it('stops before activation if the sender withdraws a package during approval', async () => {
    pending = [{ ...request, trustedPublisher: undefined }];
    mocks.confirm.mockImplementation(async () => {
      deliveryCurrent = false;
      return true;
    });
    observe();
    await expectReceipt('cancelled');
    expect(mocks.invoke).toHaveBeenCalledWith('plugin_delivery_check', {
      requestId: request.requestId, sessionId: expect.any(String),
    });
    expect(mocks.getBinding).not.toHaveBeenCalled();
    expect(mocks.addNode).not.toHaveBeenCalled();
  });

  it('installs without adding a node when the canvas is paired to another project', async () => {
    mocks.getBinding.mockResolvedValue({ enabled: true, peerProjectId: 'other-project' });
    observe();
    await expectReceipt('installed');
    expect(mocks.addNode).not.toHaveBeenCalled();
  });

  it('skips insertion when the canvas is reopened during pairing lookup', async () => {
    mocks.getBinding.mockImplementation(async () => {
      state = { ...state, projectExecutionContext: { runtimeEpoch: 'reopened' } };
      return { enabled: true, peerProjectId: projectId };
    });
    observe();
    await expectReceipt('installed');
    expect(mocks.addNode).not.toHaveBeenCalled();
  });

  it('reports failed installation without touching the canvas', async () => {
    mocks.install.mockRejectedValue(new Error('plugin registration failed'));
    observe();
    await expectReceipt('failed');
    expect(mocks.getBinding).not.toHaveBeenCalled();
    expect(mocks.addNode).not.toHaveBeenCalled();
  });
});
