import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
import type { PluginResourceStateSnapshot } from '../../src/services/plugins/pluginResourceService';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  lstat: vi.fn(),
  readFile: vi.fn(),
  resolveIndexedAssetPath: vi.fn(),
  getConvertFileSrc: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  lstat: mocks.lstat,
  readFile: mocks.readFile,
}));
vi.mock('../../src/services/fs/assetIndex', () => ({
  resolveIndexedAssetPath: mocks.resolveIndexedAssetPath,
  getRelativeAssetPath: (path: string, root: string) => (
    path.toLowerCase().startsWith(`${root.toLowerCase()}\\`)
      ? path.slice(root.length + 1).replace(/\\/g, '/')
      : null
  ),
}));
vi.mock('../../src/services/fs/core', () => ({
  getProjectDataDir: vi.fn(async () => 'G:\\project'),
  joinPath: (base: string, part: string) => `${base}\\${part.replace(/\//g, '\\')}`,
  getMimeType: (extension: string) => extension === 'png' ? 'image/png' : 'text/plain',
  getConvertFileSrc: mocks.getConvertFileSrc,
}));
vi.mock('../../src/services/fs/projectFiles', () => ({
  assertSafeProjectRelativePath: (path: string) => {
    if (path.includes('..') || /^[A-Za-z]:/u.test(path)) throw new Error('unsafe path');
    return path.replace(/\\/g, '/');
  },
}));

import {
  clearPluginResources,
  mintPluginInvocationResources,
  readPluginDerivedResourceForOutput,
  readPluginResourceRange,
  readPluginResourceText,
  registerPluginDerivedResource,
  resolvePluginResourceHostUrl,
} from '../../src/services/plugins/pluginResourceService';

const SOURCE_DIGEST = 'a'.repeat(64);
const REVISION_DIGEST = 'b'.repeat(64);

function node(id: string, data: Partial<BaseNodeData>): Node<BaseNodeData> {
  return { id, position: { x: 0, y: 0 }, data: data as BaseNodeData };
}

function createState() {
  let revision = 7;
  let edges: Edge[] = [{
    id: 'edge-1',
    source: 'source',
    target: 'target',
    targetHandle: 'plugin-in-media',
  }];
  const state: PluginResourceStateSnapshot = {
    currentProjectId: 'project-1',
    nodes: [
      node('source', { type: 'source-image', assetId: 'asset-source', fileName: 'frame.png' }),
      node('target', { type: 'plugin-node' }),
    ],
    get edges() {
      return edges;
    },
    getCurrentRevision: () => revision,
  };
  return {
    state,
    setEdges: (next: Edge[]) => { edges = next; },
    setRevision: (next: number) => { revision = next; },
  };
}

function readContext(state: PluginResourceStateSnapshot, invocationId = 'invoke-1') {
  return {
    pluginId: 'plugin-a',
    sourceDigest: SOURCE_DIGEST,
    revisionDigest: REVISION_DIGEST,
    invocationId,
    projectId: 'project-1',
    nodeId: 'target',
    baseRevision: 7,
    permissions: ['files.connected.read'] as const,
    state,
  };
}

describe('pluginResourceService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    clearPluginResources();
    vi.clearAllMocks();
    mocks.getConvertFileSrc.mockReturnValue(null);
    mocks.resolveIndexedAssetPath.mockResolvedValue('G:\\project\\assets\\frame.png');
    mocks.lstat.mockImplementation(async (path: string) => (
      path === 'G:\\project' || path === 'G:\\project\\assets'
        ? { isDirectory: true, isFile: false, isSymlink: false, size: 0, mtime: new Date(1_000) }
        : { isDirectory: false, isFile: true, isSymlink: false, size: 11, mtime: new Date(1_000) }
    ));
    mocks.readFile.mockResolvedValue(new TextEncoder().encode('hello world'));
  });

  it('mints only direct incoming resources and never exposes their path', async () => {
    const { state } = createState();
    const resources = await mintPluginInvocationResources({
      pluginId: 'plugin-a',
      sourceDigest: SOURCE_DIGEST,
      revisionDigest: REVISION_DIGEST,
      invocationId: 'invoke-1',
      projectId: 'project-1',
      nodeId: 'target',
      baseRevision: 7,
      access: { incoming: true, portIds: ['media'] },
      inputPorts: [{ id: 'media', label: '媒体', type: 'resource', accept: ['image/*'] }],
      state,
    });

    expect(resources.incoming).toHaveLength(1);
    expect(resources.inputs.media).toEqual(resources.incoming);
    expect(JSON.stringify(resources)).not.toContain('G:\\project');
    expect(JSON.stringify(resources)).not.toContain('assets/frame.png');
    await expect(readPluginResourceText(
      readContext(state),
      resources.incoming[0].resourceId,
    )).resolves.toMatchObject({ content: 'hello world' });
  });

  it('rejects another invocation and revokes a connected resource when its edge changes', async () => {
    const { state, setEdges } = createState();
    const resources = await mintPluginInvocationResources({
      pluginId: 'plugin-a',
      sourceDigest: SOURCE_DIGEST,
      revisionDigest: REVISION_DIGEST,
      invocationId: 'invoke-1',
      projectId: 'project-1',
      nodeId: 'target',
      baseRevision: 7,
      access: { incoming: true },
      inputPorts: [{ id: 'media', label: '媒体', type: 'resource' }],
      state,
    });
    const resourceId = resources.incoming[0].resourceId;

    await expect(readPluginResourceText(readContext(state, 'invoke-2'), resourceId))
      .rejects.toThrow('不属于当前调用');
    setEdges([]);
    await expect(readPluginResourceText(readContext(state), resourceId))
      .rejects.toThrow('连线已变化');
  });

  it('does not grant a custom-node resource through a missing or unknown input handle', async () => {
    const { state, setEdges } = createState();
    for (const targetHandle of [undefined, 'plugin-in-unknown']) {
      setEdges([{
        id: `edge-${targetHandle ?? 'missing'}`,
        source: 'source',
        target: 'target',
        targetHandle,
      }]);
      const resources = await mintPluginInvocationResources({
        pluginId: 'plugin-a',
        sourceDigest: SOURCE_DIGEST,
        revisionDigest: REVISION_DIGEST,
        invocationId: `invoke-${targetHandle ?? 'missing'}`,
        projectId: 'project-1',
        nodeId: 'target',
        baseRevision: 7,
        access: { incoming: true },
        inputPorts: [{ id: 'media', label: '媒体', type: 'resource' }],
        state,
      });
      expect(resources.incoming).toEqual([]);
      expect(resources.inputs).toEqual({});
    }
  });

  it('rejects multiple resource edges for a single-value input port', async () => {
    const { state, setEdges } = createState();
    setEdges([1, 2].map((index) => ({
      id: `edge-${index}`,
      source: 'source',
      target: 'target',
      targetHandle: 'plugin-in-media',
    })));

    await expect(mintPluginInvocationResources({
      pluginId: 'plugin-a',
      sourceDigest: SOURCE_DIGEST,
      revisionDigest: REVISION_DIGEST,
      invocationId: 'invoke-multiple',
      projectId: 'project-1',
      nodeId: 'target',
      baseRevision: 7,
      access: { incoming: true },
      inputPorts: [{ id: 'media', label: '媒体', type: 'resource' }],
      state,
    })).rejects.toThrow('输入「媒体」只允许一条连线');
  });

  it('binds package reads to the exact plugin revision and bounded range', async () => {
    const { state } = createState();
    mocks.invoke.mockResolvedValue([65, 66, 67]);
    const resources = await mintPluginInvocationResources({
      pluginId: 'plugin-a',
      sourceDigest: SOURCE_DIGEST,
      revisionDigest: REVISION_DIGEST,
      invocationId: 'invoke-1',
      projectId: 'project-1',
      nodeId: 'target',
      baseRevision: 7,
      packageResources: [{
        id: 'template',
        path: 'resources/template.txt',
        integrity: `sha256-${'c'.repeat(64)}`,
        mediaType: 'text/plain',
        bytes: 3,
      }],
      state,
    });
    const context = {
      ...readContext(state),
      permissions: ['plugin.resources.read'] as const,
    };

    await expect(readPluginResourceRange(
      context,
      resources.package[0].resourceId,
      0,
      3,
    )).resolves.toMatchObject({ bytes: 3, base64: 'QUJD' });
    expect(mocks.invoke).toHaveBeenCalledWith('read_plugin_package_resource', {
      pluginId: 'plugin-a',
      sourceDigest: SOURCE_DIGEST,
      revisionDigest: REVISION_DIGEST,
      resourceId: 'template',
      invocationId: 'invoke-1',
      offset: 0,
      length: 3,
    });
  });

  it('keeps derived images in the current invocation and never exposes bytes in resource metadata', async () => {
    const { state } = createState();
    const resources = await mintPluginInvocationResources({
      pluginId: 'plugin-a',
      sourceDigest: SOURCE_DIGEST,
      revisionDigest: REVISION_DIGEST,
      invocationId: 'invoke-1',
      projectId: 'project-1',
      nodeId: 'target',
      baseRevision: 7,
      state,
    });
    const context = {
      ...readContext(state),
      permissions: ['files.connected.read', 'files.output.create'] as const,
    };
    const ref = registerPluginDerivedResource(context, resources, {
      displayName: 'frame-1.jpg',
      mediaType: 'image/jpeg',
      bytes: new Uint8Array([1, 2, 3, 4]),
    });

    expect(resources.derived).toEqual([ref]);
    expect(JSON.stringify(resources)).not.toContain('1,2,3,4');
    await expect(readPluginResourceRange(context, ref.resourceId, 1, 2))
      .resolves.toMatchObject({ bytes: 2, base64: 'AgM=' });
    await expect(resolvePluginResourceHostUrl(context, ref.resourceId))
      .resolves.toBe('data:image/jpeg;base64,AQIDBA==');
    expect(readPluginDerivedResourceForOutput(context, ref.resourceId).bytes)
      .toEqual(new Uint8Array([1, 2, 3, 4]));

    clearPluginResources('plugin-a');
    expect(() => readPluginDerivedResourceForOutput(context, ref.resourceId))
      .toThrow('已失效');
  });

  it('rejects derived resources without both connected-read and output-create permissions', async () => {
    const { state } = createState();
    const resources = await mintPluginInvocationResources({
      pluginId: 'plugin-a',
      sourceDigest: SOURCE_DIGEST,
      revisionDigest: REVISION_DIGEST,
      invocationId: 'invoke-1',
      projectId: 'project-1',
      nodeId: 'target',
      baseRevision: 7,
      state,
    });
    expect(() => registerPluginDerivedResource(readContext(state), resources, {
      displayName: 'frame.jpg',
      mediaType: 'image/jpeg',
      bytes: new Uint8Array([1]),
    })).toThrow('files.connected.read 与 files.output.create');
  });

  it('does not buffer a large project file when the asset protocol ignores Range', async () => {
    const { state } = createState();
    mocks.getConvertFileSrc.mockReturnValue((path: string) => `asset://localhost/${path}`);
    mocks.lstat.mockImplementation(async (path: string) => (
      path === 'G:\\project' || path === 'G:\\project\\assets'
        ? { isDirectory: true, isFile: false, isSymlink: false, size: 0, mtime: new Date(1_000) }
        : {
            isDirectory: false,
            isFile: true,
            isSymlink: false,
            size: 17 * 1024 * 1024,
            mtime: new Date(1_000),
          }
    ));
    const fetchMock = vi.fn().mockResolvedValue(new Response('not a partial response', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const resources = await mintPluginInvocationResources({
      pluginId: 'plugin-a',
      sourceDigest: SOURCE_DIGEST,
      revisionDigest: REVISION_DIGEST,
      invocationId: 'invoke-1',
      projectId: 'project-1',
      nodeId: 'target',
      baseRevision: 7,
      access: { incoming: true, portIds: ['media'] },
      inputPorts: [{ id: 'media', label: '媒体', type: 'resource', accept: ['image/*'] }],
      state,
    });

    await expect(readPluginResourceRange(
      readContext(state),
      resources.incoming[0].resourceId,
      0,
      32,
    )).rejects.toThrow('当前环境不支持对该大型资源进行分段读取');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
