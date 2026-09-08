import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
import type { PluginResourceStateSnapshot } from '../../src/services/plugins/pluginResourceService';
import type { PluginInvocationResources } from '../../src/types/plugin';
import type { PluginLineArtImage } from '../../src/services/plugins/pluginImageService';

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
  clearPluginInvocationResources,
  clearPluginResources,
  getPluginLineArtResource,
  mintPluginInvocationResources,
  readPluginDerivedResourceForOutput,
  readPluginResourceRange,
  readPluginResourceText,
  registerPluginDerivedResource,
  replacePluginDerivedResources,
  resolvePluginResourceHostUrl,
  setPluginLineArtResource,
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

function derivedResources(): PluginInvocationResources {
  return { self: [], incoming: [], inputs: {}, package: [], derived: [] };
}

function lineArt(bytes = new Uint8Array([10, 20, 30])): PluginLineArtImage {
  return { bytes, mediaType: 'image/png', width: 640, height: 360, previewDataUrl: 'data:image/png;base64,ChQe' };
}

describe('pluginResourceService', () => {
  it('replaces full derived batches without accumulating quota and restores old leases on failure', () => {
    const { state } = createState();
    const context = { ...readContext(state), permissions: ['files.connected.read', 'files.output.create'] as const };
    const resources = { self: [], incoming: [], inputs: {}, package: [], derived: [] };
    const entries = Array.from({ length: 25 }, (_, i) => ({ displayName: `frame-${i}.jpg`, mediaType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) }));
    const first = replacePluginDerivedResources(context, resources, entries);
    const second = replacePluginDerivedResources(context, resources, entries);
    expect(resources.derived).toHaveLength(25);
    expect(() => readPluginDerivedResourceForOutput(context, first[0].resourceId)).toThrow();
    expect(readPluginDerivedResourceForOutput(context, second[0].resourceId).bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(() => replacePluginDerivedResources(context, resources, [entries[0], { ...entries[1], mediaType: 'text/plain' }])).toThrow();
    expect(resources.derived).toEqual(second);
    expect(() => readPluginDerivedResourceForOutput(context, second[0].resourceId)).not.toThrow();
  });
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

  it('keeps a single copied lineart representation without changing original bytes or metadata', () => {
    const { state } = createState();
    const context = { ...readContext(state), permissions: ['files.connected.read', 'files.output.create'] as const };
    const resources = derivedResources();
    const ref = registerPluginDerivedResource(context, resources, {
      displayName: 'frame.jpg', mediaType: 'image/jpeg', bytes: new Uint8Array([1, 2]),
    });
    const originalRef = { ...ref };
    expect(getPluginLineArtResource(context, ref.resourceId)).toBeUndefined();
    expect(() => readPluginDerivedResourceForOutput(context, ref.resourceId, 'lineart')).toThrow('线稿尚未生成');
    const image = lineArt();
    setPluginLineArtResource(context, ref.resourceId, image);
    image.bytes[0] = 255;
    image.width = 1;
    const cached = getPluginLineArtResource(context, ref.resourceId)!;
    expect(cached.bytes).toEqual(new Uint8Array([10, 20, 30]));
    expect(cached.width).toBe(640);
    cached.bytes[0] = 255;
    cached.previewDataUrl = 'changed';
    const output = readPluginDerivedResourceForOutput(context, ref.resourceId, 'lineart');
    expect(output).toEqual({
      resource: { ...originalRef, displayName: 'frame-lineart.png', mediaType: 'image/png', size: 3 },
      bytes: new Uint8Array([10, 20, 30]),
      dimensions: { width: 640, height: 360 },
    });
    output.bytes[1] = 255;
    output.resource.mediaType = 'changed';
    output.dimensions!.width = 1;
    expect(getPluginLineArtResource(context, ref.resourceId)).toEqual(lineArt());
    const original = readPluginDerivedResourceForOutput(context, ref.resourceId);
    expect(original).toEqual({ resource: originalRef, bytes: new Uint8Array([1, 2]) });
    original.resource.displayName = 'changed';
    original.bytes[0] = 255;
    expect(readPluginDerivedResourceForOutput(context, ref.resourceId)).toEqual({ resource: originalRef, bytes: new Uint8Array([1, 2]) });
    expect(ref).toEqual(originalRef);
    expect(resources.derived).toHaveLength(1);
    expect(JSON.stringify(resources)).not.toContain('previewDataUrl');
    setPluginLineArtResource(context, ref.resourceId, lineArt(new Uint8Array([40])));
    expect(getPluginLineArtResource(context, ref.resourceId)?.bytes).toEqual(new Uint8Array([40]));
    expect(resources.derived).toHaveLength(1);
  });

  it('adds lineart to 24 frames plus a contact sheet without consuming new resource IDs', () => {
    const { state } = createState();
    const context = { ...readContext(state), permissions: ['files.connected.read', 'files.output.create'] as const };
    const resources = derivedResources();
    const refs = replacePluginDerivedResources(context, resources, Array.from({ length: 25 }, (_, index) => ({
      displayName: index === 24 ? 'contact.jpg' : `frame-${index}.jpg`,
      mediaType: 'image/jpeg', bytes: new Uint8Array([index]),
    })));
    for (const ref of refs.slice(0, 24)) {
      setPluginLineArtResource(context, ref.resourceId, lineArt());
      setPluginLineArtResource(context, ref.resourceId, lineArt());
      expect(readPluginDerivedResourceForOutput(context, ref.resourceId, 'lineart').resource.resourceId).toBe(ref.resourceId);
    }
    expect(resources.derived.map((ref) => ref.resourceId)).toEqual(refs.map((ref) => ref.resourceId));
    expect(getPluginLineArtResource(context, refs[24].resourceId)).toBeUndefined();
    expect(() => registerPluginDerivedResource(context, resources, {
      displayName: 'extra.png', mediaType: 'image/png', bytes: new Uint8Array([1]),
    })).toThrow('25 个派生资源');
  });

  it('counts original and lineart bytes together and replaces a cache without accumulating quota', () => {
    const { state } = createState();
    const context = { ...readContext(state), permissions: ['files.connected.read', 'files.output.create'] as const };
    const resources = derivedResources();
    const fourMiB = new Uint8Array(4 * 1024 * 1024);
    const refs = replacePluginDerivedResources(context, resources, Array.from({ length: 11 }, (_, index) => ({
      displayName: `frame-${index}.png`, mediaType: 'image/png', bytes: fourMiB,
    })));
    setPluginLineArtResource(context, refs[0].resourceId, lineArt(fourMiB));
    expect(() => setPluginLineArtResource(context, refs[0].resourceId, lineArt(fourMiB))).not.toThrow();
    expect(() => setPluginLineArtResource(context, refs[1].resourceId, lineArt(new Uint8Array([1])))).toThrow('48 MiB');
    // 元数据不是配额真值；即使调用侧改变 size，仍按内存中实际字节计数。
    refs[0].size = 0;
    expect(() => registerPluginDerivedResource(context, resources, {
      displayName: 'extra.png', mediaType: 'image/png', bytes: new Uint8Array([1]),
    })).toThrow('48 MiB');
    setPluginLineArtResource(context, refs[0].resourceId, lineArt(fourMiB.subarray(1)));
    expect(() => setPluginLineArtResource(context, refs[1].resourceId, lineArt(new Uint8Array([1])))).not.toThrow();
    expect(() => setPluginLineArtResource(context, refs[1].resourceId, lineArt(new Uint8Array([1, 2])))).toThrow('48 MiB');
    expect(getPluginLineArtResource(context, refs[1].resourceId)?.bytes).toEqual(new Uint8Array([1]));
  });

  it('preserves previous lineart on failed replacement and clears it after atomic replacement', () => {
    const { state } = createState();
    const context = { ...readContext(state), permissions: ['files.connected.read', 'files.output.create'] as const };
    const resources = derivedResources();
    const entry = { displayName: 'frame.png', mediaType: 'image/png', bytes: new Uint8Array(4 * 1024 * 1024) };
    const oldRefs = replacePluginDerivedResources(context, resources, Array.from({ length: 6 }, () => entry));
    for (const ref of oldRefs) setPluginLineArtResource(context, ref.resourceId, lineArt(entry.bytes));
    expect(() => replacePluginDerivedResources(context, resources, [entry, { ...entry, mediaType: 'text/plain' }])).toThrow();
    expect(resources.derived).toEqual(oldRefs);
    expect(getPluginLineArtResource(context, oldRefs[0].resourceId)?.bytes.byteLength).toBe(4 * 1024 * 1024);
    expect(() => setPluginLineArtResource(context, oldRefs[0].resourceId, lineArt(entry.bytes))).not.toThrow();
    // 暂存期间旧批次及其缓存仍存在，但不得阻止新批次使用完整 48 MiB 额度。
    const nextRefs = replacePluginDerivedResources(context, resources, Array.from({ length: 12 }, () => entry));
    expect(resources.derived).toEqual(nextRefs);
    expect(() => getPluginLineArtResource(context, oldRefs[0].resourceId)).toThrow('已失效');
    expect(getPluginLineArtResource(context, nextRefs[0].resourceId)).toBeUndefined();
    expect(() => setPluginLineArtResource(context, nextRefs[0].resourceId, lineArt())).toThrow('48 MiB');
    clearPluginInvocationResources(context.invocationId);
    expect(() => getPluginLineArtResource(context, nextRefs[0].resourceId)).toThrow('已失效');
  });

  it('rejects invalid lineart or non-derived resources while retaining an existing valid cache', async () => {
    const { state } = createState();
    const context = { ...readContext(state), permissions: ['files.connected.read', 'files.output.create'] as const };
    const resources = await mintPluginInvocationResources({ ...context, access: { incoming: true } });
    const connectedId = resources.incoming[0].resourceId;
    expect(() => getPluginLineArtResource(context, connectedId)).toThrow('宿主派生资源');
    expect(() => setPluginLineArtResource(context, connectedId, lineArt())).toThrow('宿主派生资源');
    const ref = registerPluginDerivedResource(context, resources, {
      displayName: 'frame.png', mediaType: 'image/png', bytes: new Uint8Array([1]),
    });
    setPluginLineArtResource(context, ref.resourceId, lineArt());
    for (const bytes of [new Uint8Array(), new Uint8Array(4 * 1024 * 1024 + 1)]) {
      expect(() => setPluginLineArtResource(context, ref.resourceId, lineArt(bytes))).toThrow('4 MiB');
    }
    for (const width of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => setPluginLineArtResource(context, ref.resourceId, { ...lineArt(), width })).toThrow('尺寸无效');
    }
    expect(() => setPluginLineArtResource(context, ref.resourceId, { ...lineArt(), height: 0 })).toThrow('尺寸无效');
    expect(() => setPluginLineArtResource(context, ref.resourceId, { ...lineArt(), mediaType: 'image/jpeg' } as unknown as PluginLineArtImage)).toThrow('PNG');
    expect(() => readPluginDerivedResourceForOutput(context, ref.resourceId, 'other' as 'original')).toThrow('表示无效');
    expect(getPluginLineArtResource(context, ref.resourceId)).toEqual(lineArt());
  });

  it('revalidates lineart permissions, invocation, revision and cleanup before every read or write', () => {
    const { state, setRevision } = createState();
    const context = { ...readContext(state), permissions: ['files.connected.read', 'files.output.create'] as const };
    const resources = derivedResources();
    const ref = registerPluginDerivedResource(context, resources, {
      displayName: 'frame.png', mediaType: 'image/png', bytes: new Uint8Array([1]),
    });
    setPluginLineArtResource(context, ref.resourceId, lineArt());
    for (const invalid of [
      { ...context, invocationId: 'other' },
      { ...context, revisionDigest: 'c'.repeat(64) },
      { ...context, permissions: ['files.connected.read'] as const },
      { ...context, permissions: ['files.output.create'] as const },
    ]) {
      expect(() => getPluginLineArtResource(invalid, ref.resourceId)).toThrow();
      expect(() => setPluginLineArtResource(invalid, ref.resourceId, lineArt())).toThrow();
      expect(() => readPluginDerivedResourceForOutput(invalid, ref.resourceId, 'lineart')).toThrow();
    }
    setRevision(8);
    expect(() => getPluginLineArtResource(context, ref.resourceId)).toThrow('已撤销');
    expect(() => setPluginLineArtResource(context, ref.resourceId, lineArt())).toThrow('已撤销');
    setRevision(7);
    clearPluginResources('other-plugin');
    expect(getPluginLineArtResource(context, ref.resourceId)).toEqual(lineArt());
    clearPluginResources('plugin-a');
    expect(() => getPluginLineArtResource(context, ref.resourceId)).toThrow('已失效');
    expect(() => setPluginLineArtResource(context, ref.resourceId, lineArt())).toThrow('已失效');
  });

  it('clears only the ended invocation and keeps another invocation lineart available', () => {
    const { state } = createState();
    const firstContext = { ...readContext(state), permissions: ['files.connected.read', 'files.output.create'] as const };
    const secondContext = { ...firstContext, invocationId: 'invoke-2' };
    const refs = [firstContext, secondContext].map((context) => {
      const ref = registerPluginDerivedResource(context, derivedResources(), {
        displayName: 'frame.png', mediaType: 'image/png', bytes: new Uint8Array([1]),
      });
      setPluginLineArtResource(context, ref.resourceId, lineArt());
      return ref;
    });
    clearPluginInvocationResources(firstContext.invocationId);
    expect(() => readPluginDerivedResourceForOutput(firstContext, refs[0].resourceId, 'lineart')).toThrow('已失效');
    expect(getPluginLineArtResource(secondContext, refs[1].resourceId)).toEqual(lineArt());
    clearPluginResources();
    expect(() => getPluginLineArtResource(secondContext, refs[1].resourceId)).toThrow('已失效');
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
