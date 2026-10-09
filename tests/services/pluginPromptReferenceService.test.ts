import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginInvocationResources } from '../../src/types/plugin';
import type { PluginResourceReadContext } from '../../src/services/plugins/pluginResourceService';

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown>, revision: 3, lstat: vi.fn(), open: vi.fn(), read: vi.fn(), close: vi.fn(), bitmap: vi.fn(), encode: vi.fn(),
  canvases: [] as Array<{ width: number; height: number; drawImage: ReturnType<typeof vi.fn>; toBlob: ReturnType<typeof vi.fn> }>,
  globalFiles: vi.fn(), folderFiles: vi.fn(), loadGlobals: vi.fn(), resolveChat: vi.fn() }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.state } }));
vi.mock('@tauri-apps/plugin-fs', () => ({ lstat: mocks.lstat, open: mocks.open }));
vi.mock('../../src/services/fileService', () => ({ listGlobalFiles: mocks.globalFiles, listExternalFolderFiles: mocks.folderFiles }));
vi.mock('../../src/services/ai/promptResolver', () => ({ resolvePromptToChatContent: mocks.resolveChat }));
import { clearPluginPromptReferences, clearPluginPromptReferencesForPlugin, queryPluginPromptMentions, rewritePluginPromptReferences, resolvePluginPromptReferencesForModel } from '../../src/services/plugins/pluginPromptReferenceService';
import { clearPluginInvocationResources, clearPluginResources } from '../../src/services/plugins/pluginResourceService';
import { parseRasterImageDimensions } from '../../src/services/rasterImageDimensions';

const sourceDigest = 'a'.repeat(64), revisionDigest = 'b'.repeat(64);
function options() {
  const resources: PluginInvocationResources = { self: [], incoming: [], inputs: {}, package: [], derived: [] };
  const context = { pluginId: 'plugin.test', sourceDigest, revisionDigest, invocationId: crypto.randomUUID(), projectId: 'project', nodeId: 'source', baseRevision: 3,
    permissions: ['prompt.references.read'], state: mocks.state } as unknown as PluginResourceReadContext;
  return { resources, context };
}
function character(id: string) {
  return { id, kind: 'character', key: id, name: `人物 ${id}`, createdAt: 1, updatedAt: 1, summary: '不会交给插件的设定正文',
    referenceImages: [{ id: 'side', kind: 'turnaround', imageUrl: 'data:image/png;base64,c2lkZQ==', prompt: '', createdAt: 1, updatedAt: 1 }] };
}
function png(width = 8, height = 4): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(57);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); bytes.set(new TextEncoder().encode('IHDR'), 12);
  view.setUint32(16, width); view.setUint32(20, height); bytes[24] = 8; bytes[25] = 6;
  bytes.set(new TextEncoder().encode('IDAT'), 37); bytes.set(new TextEncoder().encode('IEND'), 49);
  return bytes;
}
function dataUrl(bytes: Uint8Array, mime = 'image/png'): string { return `data:${mime};base64,${btoa(String.fromCharCode(...bytes))}`; }
function jpeg(width: number, height: number, size = 17): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0, 0xff, 0xd9]);
  return bytes;
}
function addImageNode(source = dataUrl(png()), displayId = 7): void {
  (mocks.state.nodes as Array<Record<string, unknown>>).push({ id: 'image', type: 'source-image', data: { type: 'source-image', label: '参考图', imageUrl: source, displayId } });
  (mocks.state.edges as Array<Record<string, unknown>>).push({ source: 'image', target: 'source' });
}
function installPreviewEnvironment(bytes = png()): void {
  vi.stubGlobal('createImageBitmap', mocks.bitmap);
  mocks.bitmap.mockImplementation(async (blob: Blob) => ({ ...parseRasterImageDimensions(new Uint8Array(await blob.arrayBuffer())), close: vi.fn() }));
  vi.stubGlobal('document', { createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error('unexpected DOM element');
    const canvas = { width: 0, height: 0, drawImage: vi.fn(), toBlob: vi.fn(), getContext: vi.fn() };
    canvas.getContext.mockReturnValue({ fillRect: vi.fn(), drawImage: canvas.drawImage });
    canvas.toBlob.mockImplementation((callback: (blob: Blob) => void, type: string) => mocks.encode(canvas, callback, type));
    mocks.canvases.push(canvas);
    return canvas;
  } });
  mocks.encode.mockImplementation((canvas: { width: number; height: number }, callback: (blob: Blob) => void, type: string) => callback(new Blob([new Uint8Array(jpeg(canvas.width, canvas.height))], { type })));
  mocks.lstat.mockResolvedValue({ isFile: true, isSymlink: false, size: bytes.length, mtime: new Date(10) });
  mocks.open.mockImplementation(async () => {
    let offset = 0;
    return { read: async (target: Uint8Array) => {
      await mocks.read(target);
      const count = Math.min(target.length, bytes.length - offset);
      target.set(bytes.subarray(offset, offset + count)); offset += count;
      return count || null;
    }, close: mocks.close };
  });
  mocks.read.mockResolvedValue(undefined); mocks.close.mockResolvedValue(undefined);
}
beforeEach(() => {
  clearPluginPromptReferencesForPlugin();
  vi.clearAllMocks(); mocks.revision = 3;
  mocks.canvases = [];
  mocks.state = { currentProjectId: 'project', getCurrentRevision: () => mocks.revision,
    installedPlugins: [{ id: 'plugin.test', enabled: true, sourceDigest, revisionDigest, manifest: { apiVersion: 2, permissions: ['prompt.references.read'], requiredCapabilities: ['prompt.mentions'] } }],
    nodes: [{ id: 'source', type: 'source-video', data: { type: 'source-video', label: '视频', videoUrl: 'asset://localhost/private.mp4' } },
      { id: 'text', type: 'ai-text', data: { type: 'ai-text', label: '设定', output: '不能返回给插件的正文' } },
      { id: 'foreign', type: 'ai-text', data: { type: 'ai-text', label: '没有入边的节点', output: '不授权正文' } }],
    edges: [{ id: 'e', source: 'text', target: 'source' }],
    dramaAssets: { version: 2, characters: [character('project')], scenes: [{ id: 'scene', kind: 'scene', name: '街道', summary: '场景正文' }], props: [] },
    globalCharacters: [character('global')], loadGlobalCharacters: mocks.loadGlobals, config: { assetFolders: ['D:\\registered'] } };
  mocks.loadGlobals.mockResolvedValue(undefined);
  mocks.globalFiles.mockResolvedValue([{ name: '背景.png', path: 'D:\\private\\背景.png', category: 'image', size: 12, source: 'global' }]);
  mocks.folderFiles.mockResolvedValue([{ name: '背景.png', path: 'D:\\private\\背景.png', category: 'image', size: 12, source: 'folder' },
    { name: '音频.mp3', path: 'D:\\registered\\音频.mp3', category: 'audio', size: 12 }]);
  mocks.lstat.mockResolvedValue({ isFile: true, isSymlink: false, size: 12, mtime: new Date(10) });
  mocks.resolveChat.mockResolvedValue({ textContent: '安全展开正文', content: [{ type: 'text', text: '安全展开正文' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }] });
});
afterEach(() => clearPluginPromptReferencesForPlugin());
describe('plugin prompt reference broker', () => {
  it('returns only metadata and opaque handles for self and connected canvas nodes', async () => {
    const opts = options();
    const page = await queryPluginPromptMentions({ ...opts, source: 'nodes' });
    expect(page.items.map((item) => item.label)).toEqual(['视频', '设定']);
    expect(page.items.every((item) => item.id.startsWith('plugin-ref-') && item.token.startsWith(`@{${item.id}:`))).toBe(true);
    expect(JSON.stringify(page)).not.toMatch(/localhost|正文|foreign/);
    expect(await rewritePluginPromptReferences(page.items[1].token, opts)).toBe('@{text:设定}');
  });
  it('keeps real storyboard and shotlist nodes while omitting virtual storyboard cells', async () => {
    (mocks.state.nodes as Array<Record<string, unknown>>).push(
      { id: 'board', type: 'ai-storyboard', data: { type: 'ai-storyboard', label: '分镜整图', imageUrl: 'data:image/png;base64,YQ==', storyboardCols: 2, storyboardRows: 2 } },
      { id: 'shotlist', type: 'ai-shotlist', data: { type: 'ai-shotlist', label: '分镜清单', output: '逐镜描述' } },
    );
    (mocks.state.edges as Array<Record<string, unknown>>).push({ source: 'board', target: 'source' }, { source: 'shotlist', target: 'source' });
    const opts = options(); const page = await queryPluginPromptMentions({ ...opts, source: 'nodes' });
    expect(page.items.map((item) => item.label)).toEqual(['视频', '设定', '分镜整图', '分镜清单']);
    const prompts = await Promise.all(page.items.map((item) => rewritePluginPromptReferences(item.token, opts)));
    expect(prompts).toContain('@{board:分镜整图}');
    expect(prompts).toContain('@{shotlist:分镜清单}');
    expect(prompts.join(' ')).not.toContain('/cell/');
  });
  it('includes global and project characters, scenes and exact reference picks without leaking images or descriptions', async () => {
    const opts = options(); const page = await queryPluginPromptMentions({ ...opts, source: 'characters' });
    expect(page.items.map((item) => item.kind)).toEqual(['character', 'image', 'character', 'image', 'scene']);
    const global = page.items.find((item) => item.label === '人物 global（全局）')!;
    const reference = page.items.find((item) => item.label === '人物 global（全局） · 参考图 1')!;
    expect(await rewritePluginPromptReferences(global.token, opts)).toBe('@drama{global/global:人物 global}');
    expect(await rewritePluginPromptReferences(reference.token, opts)).toBe('@drama{global/global#side:人物 global}');
    expect(JSON.stringify(page)).not.toMatch(/base64|设定正文|场景正文/);
    expect(mocks.loadGlobals).toHaveBeenCalledTimes(1);
  });
  it('mints exact reference picks backed by a drawable source node and revokes them when that node changes', async () => {
    const project = character('project');
    project.referenceImages = [{ ...project.referenceImages[0], imageUrl: '', sourceNodeId: 'drawing' } as typeof project.referenceImages[0]];
    mocks.state.dramaAssets = { version: 2, characters: [project], scenes: [], props: [] };
    (mocks.state.nodes as Array<Record<string, unknown>>).push({ id: 'drawing', type: 'source-image', data: { imageUrl: 'data:image/png;base64,ZHJhd2luZw==' } });
    const opts = options(); const page = await queryPluginPromptMentions({ ...opts, source: 'characters' });
    const reference = page.items.find((item) => item.label === '人物 project · 参考图 1')!;
    expect(reference).toBeDefined();
    expect(await rewritePluginPromptReferences(reference.token, opts)).toBe('@drama{project#side:人物 project}');
    (mocks.state.nodes as Array<{ data: Record<string, unknown> }>).at(-1)!.data.imageUrl = '';
    await expect(rewritePluginPromptReferences(reference.token, opts)).rejects.toThrow('已删除、变更或撤销');
  });
  it('does not offer an empty single reference by falling back to another appearance image', async () => {
    mocks.state.dramaAssets = { version: 2, characters: [{ ...character('empty'), imageUrl: 'data:image/png;base64,b3RoZXI=', referenceImages: [{ id: 'missing', imageUrl: '' }] }], scenes: [], props: [] };
    mocks.state.globalCharacters = [];
    expect((await queryPluginPromptMentions({ ...options(), source: 'characters' })).items.map((item) => item.kind)).toEqual(['character']);
  });
  it('omits identities that canonical parsers could resolve to another node or asset', async () => {
    (mocks.state.nodes as Array<Record<string, unknown>>).push({ id: 'foreign:fake', data: { label: '错误节点身份', output: '正文' } });
    (mocks.state.edges as Array<Record<string, unknown>>).push({ source: 'foreign:fake', target: 'source' });
    mocks.state.dramaAssets = { version: 2, characters: [character('invalid#pick'), character('global/shadow'),
      { ...character('safe'), referenceImages: ['all', 'voice/other', 'invalid:pick'].map((id) => ({ id, imageUrl: 'data:image/png;base64,eA==' })) }], scenes: [], props: [] };
    mocks.state.globalCharacters = [];
    const opts = options();
    expect((await queryPluginPromptMentions({ ...opts, source: 'nodes' })).items.map((item) => item.label)).not.toContain('错误节点身份');
    expect((await queryPluginPromptMentions({ ...opts, source: 'characters' })).items.map((item) => item.label)).toEqual(['人物 safe']);
  });
  it('keeps unusual labels intact as opaque references inside JSON analysis prompts', async () => {
    mocks.state.dramaAssets = { version: 2, characters: [{ ...character('odd'), name: '人物: "名字" \\ {别称}\n' }], scenes: [], props: [] };
    mocks.state.globalCharacters = [];
    const opts = options(); const page = await queryPluginPromptMentions({ ...opts, source: 'characters' });
    const token = page.items[0].token;
    expect(page.items[0].label).not.toMatch(/[:{}"\\\r\n]/u);
    const result = await resolvePluginPromptReferencesForModel(JSON.stringify({ requirements: token }), opts);
    expect(result.prompt).toBe('安全展开正文');
    expect(mocks.resolveChat.mock.calls[0][0]).toContain(`@drama{odd:${page.items[0].label}}`);
  });
  it('paginates beyond the existing drama selector first 20 entries and filters labels', async () => {
    mocks.state.dramaAssets = { version: 2, characters: Array.from({ length: 24 }, (_, index) => ({ ...character(String(index)), referenceImages: [] })), scenes: [], props: [] };
    mocks.state.globalCharacters = [];
    const opts = options(); const first = await queryPluginPromptMentions({ ...opts, source: 'characters' });
    expect(first.items).toHaveLength(20); expect(first.nextOffset).toBe(20);
    expect((await queryPluginPromptMentions({ ...opts, source: 'characters', offset: 20 })).items).toHaveLength(4);
    expect((await queryPluginPromptMentions({ ...opts, source: 'characters', query: '人物 23' })).items).toHaveLength(1);
  });
  it('deduplicates registered image assets and keeps their paths inside the host', async () => {
    const opts = options(); const page = await queryPluginPromptMentions({ ...opts, source: 'assets' });
    expect(page.items).toHaveLength(1); expect(page.items[0].label).toBe('背景.png');
    expect(JSON.stringify(page)).not.toMatch(/private|registered|D:|mp3/);
    expect(await rewritePluginPromptReferences(page.items[0].token, opts)).toBe(`@asset{${encodeURIComponent('D:\\private\\背景.png')}}`);
    expect(mocks.folderFiles).toHaveBeenCalledWith(['D:\\registered']);
  });
  it('enforces the text limit after expanding an opaque handle into a longer canonical asset reference', async () => {
    const path = `D:\\private\\${'a'.repeat(200)}.png`;
    mocks.globalFiles.mockResolvedValue([{ name: '背景.png', path, category: 'image', size: 12, source: 'global' }]);
    mocks.folderFiles.mockResolvedValue([]);
    const opts = options(); const page = await queryPluginPromptMentions({ ...opts, source: 'assets' });
    const token = page.items[0].token;
    const canonical = `@asset{${encodeURIComponent(path)}}`;
    expect(canonical.length).toBeGreaterThan(token.length);
    const boundary = 'x'.repeat(256_000 - canonical.length) + token;
    expect((await rewritePluginPromptReferences(boundary, opts)).length).toBe(256_000);
    await expect(rewritePluginPromptReferences(`x${boundary}`, opts)).rejects.toThrow('重写后的插件提示词不能超过 256000 字符');
  });
  it.each(['@{foreign:私造节点}', '@drama{project:私造人物}', '@asset{D:\\private\\secret.png}', '@{plugin-ref-00000000-0000-0000-0000-000000000000:伪造}', '@{unfinished'])('rejects unminted or canonical references %s', async (text) => {
    await expect(rewritePluginPromptReferences(text, options())).rejects.toThrow();
  });
  it('keeps ordinary text compatible without the new permission', async () => {
    const opts = options(); opts.context.permissions = [];
    mocks.state.currentProjectId = 'other'; mocks.state.installedPlugins = [];
    expect(await rewritePluginPromptReferences('普通说明', opts)).toBe('普通说明');
    expect(await resolvePluginPromptReferencesForModel('普通说明', opts)).toEqual({ prompt: '普通说明', imageUrls: [] });
    expect(mocks.resolveChat).not.toHaveBeenCalled();
  });
  it.each(['invocation', 'plugin', 'all'])('revokes handles through resource cleanup for %s scope and mints fresh handles on a new query', async (scope) => {
    const opts = options(); const first = await queryPluginPromptMentions({ ...opts, source: 'nodes' });
    if (scope === 'invocation') clearPluginInvocationResources(opts.context.invocationId);
    if (scope === 'plugin') clearPluginResources(opts.context.pluginId);
    if (scope === 'all') clearPluginResources();
    await expect(rewritePluginPromptReferences(first.items[0].token, opts)).rejects.toThrow('本次宿主授权');
    const next = await queryPluginPromptMentions({ ...opts, source: 'nodes' });
    expect(next.items[0].token).not.toBe(first.items[0].token);
  });
  it('does not resurrect handles when cleanup races with a filesystem query', async () => {
    const opts = options();
    mocks.lstat.mockImplementationOnce(async () => { clearPluginPromptReferences(opts.context.invocationId); return { isFile: true, isSymlink: false, size: 12, mtime: new Date(10) }; });
    await expect(queryPluginPromptMentions({ ...opts, source: 'assets' })).rejects.toThrow('租约已撤销');
  });
  it('bounds active reference invocations and frees the quota on cleanup', async () => {
    const active = [];
    for (let index = 0; index < 16; index += 1) {
      const opts = options(); active.push(opts);
      await queryPluginPromptMentions({ ...opts, source: 'nodes' });
    }
    const next = options();
    await expect(queryPluginPromptMentions({ ...next, source: 'nodes' })).rejects.toThrow('16');
    clearPluginPromptReferences(active[0].context.invocationId);
    await expect(queryPluginPromptMentions({ ...next, source: 'nodes' })).resolves.toMatchObject({ hasMore: false });
  });
  it.each([{ query: 'a'.repeat(121) }, { offset: -1 }, { offset: 1.5 }, { offset: 10_001 }])('rejects invalid query arguments %j', async (args) => {
    await expect(queryPluginPromptMentions({ ...options(), source: 'nodes', ...args })).rejects.toThrow('查询无效');
  });
  it('accepts the shared 120-character query limit', async () => {
    await expect(queryPluginPromptMentions({ ...options(), source: 'nodes', query: 'a'.repeat(120) })).resolves.toMatchObject({ items: [] });
  });
  it.each(['permission', 'revision', 'project', 'node', 'disabled', 'digest', 'foreign-invocation', 'foreign-resources', 'changed-node', 'unlinked', 'changed-character', 'deleted-character', 'changed-file', 'removed-file', 'symlink', 'renamed-label'])('revokes %s references', async (failure) => {
    const opts = options();
    const source = ['changed-file', 'removed-file', 'symlink'].includes(failure) ? 'assets' : ['changed-character', 'deleted-character'].includes(failure) ? 'characters' : 'nodes';
    const page = await queryPluginPromptMentions({ ...opts, source });
    const token = source === 'nodes' ? page.items[1].token : page.items[0].token;
    if (failure === 'permission') opts.context.permissions = [];
    if (failure === 'revision') mocks.revision += 1;
    if (failure === 'project') mocks.state.currentProjectId = 'other';
    if (failure === 'node') mocks.state.nodes = [];
    if (failure === 'disabled') (mocks.state.installedPlugins as Array<Record<string, unknown>>)[0].enabled = false;
    if (failure === 'digest') (mocks.state.installedPlugins as Array<Record<string, unknown>>)[0].revisionDigest = 'c'.repeat(64);
    if (failure === 'foreign-invocation') opts.context.invocationId = 'other';
    if (failure === 'foreign-resources') opts.resources = options().resources;
    if (failure === 'changed-node') (mocks.state.nodes as Array<{ data: Record<string, unknown> }>)[1].data.output = '新正文';
    if (failure === 'unlinked') mocks.state.edges = [];
    if (failure === 'changed-character') (mocks.state.dramaAssets as { characters: Array<Record<string, unknown>> }).characters[0].summary = '新设定';
    if (failure === 'deleted-character') (mocks.state.dramaAssets as { characters: unknown[] }).characters = [];
    if (failure === 'changed-file') mocks.lstat.mockResolvedValue({ isFile: true, isSymlink: false, size: 13, mtime: new Date(11) });
    if (failure === 'removed-file') { mocks.globalFiles.mockResolvedValue([]); mocks.folderFiles.mockResolvedValue([]); }
    if (failure === 'symlink') mocks.lstat.mockResolvedValue({ isFile: true, isSymlink: true, size: 12, mtime: new Date(10) });
    await expect(rewritePluginPromptReferences(failure === 'renamed-label' ? token.replace('设定', '改名') : token, opts)).rejects.toThrow();
  });
  it('expands authorized content only for the host model and removes nested unauthorized references', async () => {
    const opts = options(); const page = await queryPluginPromptMentions({ ...opts, source: 'nodes' });
    mocks.resolveChat.mockResolvedValue({ textContent: '已有设定 @{foreign:未授权} @asset{secret}', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] });
    const result = await resolvePluginPromptReferencesForModel(`${page.items[0].token} ${page.items[1].token}`, opts);
    expect(mocks.resolveChat).toHaveBeenCalledWith('[视频] @{text:设定}');
    expect(result).toEqual({ prompt: '已有设定 [未授权] [资源引用]', imageUrls: ['data:image/png;base64,YQ=='] });
  });
  it('rechecks bindings after asynchronous content resolution', async () => {
    const opts = options(); const page = await queryPluginPromptMentions({ ...opts, source: 'nodes' });
    mocks.resolveChat.mockImplementationOnce(async () => { mocks.revision += 1; return { textContent: '迟到正文', content: '迟到正文' }; });
    await expect(resolvePluginPromptReferencesForModel(page.items[1].token, opts)).rejects.toThrow('画布已变化');
  });
  it('does not disclose native filesystem exception paths', async () => {
    mocks.lstat.mockRejectedValueOnce(new Error('Cannot read D:\\private\\secret.png'));
    await expect(queryPluginPromptMentions({ ...options(), source: 'assets' })).rejects.toThrow('已离线或无法读取');
  });
});

describe('plugin prompt reference previews', () => {
  it('does not decode or disclose images unless preview is explicitly enabled and never caches presentation in opaque handles', async () => {
    installPreviewEnvironment(); addImageNode();
    const opts = options();
    const first = await queryPluginPromptMentions({ ...opts, source: 'nodes' });
    expect(mocks.bitmap).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled();
    expect(JSON.stringify(first)).not.toMatch(/base64|thumbnail|badge/);
    const preview = await queryPluginPromptMentions({ ...opts, source: 'nodes', preview: true });
    const image = preview.items.find((item) => item.label === '参考图')!;
    expect(image).toMatchObject({ thumbnailDataUrl: expect.stringMatching(/^data:image\/jpeg;base64,/u), badge: '#7' });
    expect(preview.items[0].badge).toBe('自身');
    expect(image.token).toBe(first.items.at(-1)!.token);
    const plain = await queryPluginPromptMentions({ ...opts, source: 'nodes', preview: false });
    expect(JSON.stringify(plain)).not.toMatch(/base64|thumbnail|badge/);
    expect(await rewritePluginPromptReferences(image.token, opts)).toBe('@{image:参考图}');
  });
  it('downscales images to at most 160 pixels and closes decoded bitmaps and canvas memory', async () => {
    installPreviewEnvironment(); addImageNode(dataUrl(png(800, 400)));
    const page = await queryPluginPromptMentions({ ...options(), source: 'nodes', preview: true });
    expect(mocks.canvases[0].drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 160, 80);
    expect(parseRasterImageDimensions(Uint8Array.from(atob(page.items.at(-1)!.thumbnailDataUrl!.split(',')[1]), (value) => value.charCodeAt(0)))).toEqual({ width: 160, height: 80 });
    expect((await mocks.bitmap.mock.results[0].value).close).toHaveBeenCalledOnce();
    expect(mocks.canvases[0]).toMatchObject({ width: 0, height: 0 });
  });
  it('reads only registered assets using bounded file buffers and returns a reencoded JPEG without the source path', async () => {
    installPreviewEnvironment();
    const page = await queryPluginPromptMentions({ ...options(), source: 'assets', preview: true });
    expect(mocks.open).toHaveBeenCalledWith('D:\\private\\背景.png', { read: true });
    expect(mocks.read.mock.calls.map(([buffer]) => (buffer as Uint8Array).length)).toEqual([57, 1]);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(page.items[0].thumbnailDataUrl).toMatch(/^data:image\/jpeg;base64,/u);
    expect(JSON.stringify(page)).not.toMatch(/D:|private|asset:|png;base64/);
  });
  it('binds avatar crop to the selected drawable reference and keeps reference picks uncropped', async () => {
    installPreviewEnvironment();
    const asset = { ...character('avatar'), avatarReferenceImageId: 'side', avatarCrop: { x: 0.25, y: 0.1, width: 0.5, height: 0.75 },
      referenceImages: [{ ...character('avatar').referenceImages[0], imageUrl: dataUrl(png()) }] };
    mocks.state.dramaAssets = { version: 2, characters: [asset], scenes: [], props: [] }; mocks.state.globalCharacters = [];
    const opts = options(); const page = await queryPluginPromptMentions({ ...opts, source: 'characters', preview: true });
    expect(page.items[0].thumbnailCrop).toEqual(asset.avatarCrop);
    expect(page.items[1].thumbnailCrop).toBeUndefined();
    expect(page.items[1].badge).toBe('参考图 1');
    expect(await rewritePluginPromptReferences(page.items[0].token, opts)).toBe('@drama{avatar:人物 avatar}');
  });
  it.each([{ x: 0, y: 0, width: 0, height: 1 }, { x: 0.8, y: 0, width: 0.5, height: 1 },
    { x: 0, y: 0, width: Number.NaN, height: 1 }, { x: 0, y: 0, width: 0.000001, height: 1 }])('omits invalid avatar crop %j', async (crop) => {
    installPreviewEnvironment();
    mocks.state.dramaAssets = { version: 2, characters: [{ ...character('avatar'), avatarReferenceImageId: 'side', avatarCrop: crop,
      referenceImages: [{ ...character('avatar').referenceImages[0], imageUrl: dataUrl(png()) }] }], scenes: [], props: [] }; mocks.state.globalCharacters = [];
    expect((await queryPluginPromptMentions({ ...options(), source: 'characters', preview: true })).items[0].thumbnailCrop).toBeUndefined();
  });
  it('does not apply avatar crop after falling back from an empty avatar reference', async () => {
    installPreviewEnvironment();
    mocks.state.dramaAssets = { version: 2, characters: [{ ...character('avatar'), avatarReferenceImageId: 'side', avatarCrop: { x: 0, y: 0, width: 0.5, height: 0.5 },
      imageUrl: dataUrl(png()), referenceImages: [{ ...character('avatar').referenceImages[0], imageUrl: '' }] }], scenes: [], props: [] }; mocks.state.globalCharacters = [];
    const page = await queryPluginPromptMentions({ ...options(), source: 'characters', preview: true });
    expect(page.items[0].thumbnailDataUrl).toBeDefined(); expect(page.items[0].thumbnailCrop).toBeUndefined();
  });
  it('uses drawable source-node references for avatar previews', async () => {
    installPreviewEnvironment(); addImageNode();
    mocks.state.dramaAssets = { version: 2, characters: [{ ...character('avatar'), avatarReferenceImageId: 'side', avatarCrop: { x: 0, y: 0, width: 0.5, height: 0.5 },
      referenceImages: [{ ...character('avatar').referenceImages[0], imageUrl: '', sourceNodeId: 'image' }] }], scenes: [], props: [] }; mocks.state.globalCharacters = [];
    const page = await queryPluginPromptMentions({ ...options(), source: 'characters', preview: true });
    expect(page.items.every((item) => item.thumbnailDataUrl)).toBe(true);
    expect(page.items[0].thumbnailCrop).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 });
  });
  it('uses the avatar image rather than applying its crop to a different bound primary node', async () => {
    installPreviewEnvironment(); addImageNode(dataUrl(png(12, 6)));
    mocks.state.dramaAssets = { version: 2, characters: [{ ...character('avatar'), imageNodeId: 'image', avatarReferenceImageId: 'side',
      avatarCrop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, referenceImages: [{ ...character('avatar').referenceImages[0], imageUrl: dataUrl(png(8, 4)) }] }], scenes: [], props: [] };
    mocks.state.globalCharacters = [];
    const page = await queryPluginPromptMentions({ ...options(), source: 'characters', preview: true });
    const bytes = Uint8Array.from(atob(page.items[0].thumbnailDataUrl!.split(',')[1]), (value) => value.charCodeAt(0));
    expect(parseRasterImageDimensions(bytes)).toEqual({ width: 8, height: 4 });
    expect(page.items[0].thumbnailCrop).toEqual({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 });
  });
  it('keeps remote images as icons without fetching a URL or misreading a video file as an image', async () => {
    installPreviewEnvironment(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    addImageNode('https://example.invalid/remote.png');
    const self = (mocks.state.nodes as Array<{ data: Record<string, unknown> }>)[0];
    self.data.thumbnailUrl = 'https://example.invalid/video-poster.jpg'; self.data.filePath = 'D:\\private\\video.mp4';
    const page = await queryPluginPromptMentions({ ...options(), source: 'nodes', preview: true });
    expect(page.items.every((item) => !item.thumbnailDataUrl)).toBe(true);
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled(); expect(mocks.bitmap).not.toHaveBeenCalled();
  });
  it.each([dataUrl(png(100_000, 100_000)), dataUrl(new TextEncoder().encode('<svg width="1" height="1"/>'), 'image/svg+xml'),
    dataUrl(new TextEncoder().encode('GIF89a'), 'image/gif')])('rejects unsafe formats and oversized encoded pixel counts before bitmap decode', async (source) => {
    installPreviewEnvironment(); addImageNode(source);
    expect((await queryPluginPromptMentions({ ...options(), source: 'nodes', preview: true })).items.at(-1)!.thumbnailDataUrl).toBeUndefined();
    expect(mocks.bitmap).not.toHaveBeenCalled();
  });
  it('rejects multiple JPEG frame headers rather than trusting a later small frame', async () => {
    installPreviewEnvironment();
    const big = jpeg(65_000, 65_000), small = jpeg(8, 4);
    const bytes = new Uint8Array(30); bytes.set(big.subarray(0, 15)); bytes.set(small.subarray(2), 15);
    addImageNode(dataUrl(bytes, 'image/jpeg'));
    expect((await queryPluginPromptMentions({ ...options(), source: 'nodes', preview: true })).items.at(-1)!.thumbnailDataUrl).toBeUndefined();
    expect(mocks.bitmap).not.toHaveBeenCalled();
  });
  it('rejects a mismatched WebP canvas before bitmap decode', async () => {
    installPreviewEnvironment();
    const bytes = new Uint8Array(48); const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('RIFF')); view.setUint32(4, 40, true); bytes.set(new TextEncoder().encode('WEBPVP8X'), 8);
    view.setUint32(16, 10, true); bytes[24] = 7; bytes[27] = 3;
    bytes.set(new TextEncoder().encode('VP8 '), 30); view.setUint32(34, 10, true);
    bytes.set([0x9d, 1, 0x2a, 9, 0, 4, 0], 41);
    addImageNode(dataUrl(bytes, 'image/webp'));
    expect((await queryPluginPromptMentions({ ...options(), source: 'nodes', preview: true })).items.at(-1)!.thumbnailDataUrl).toBeUndefined();
    expect(mocks.bitmap).not.toHaveBeenCalled();
  });
  it('rejects oversized local files before opening them', async () => {
    installPreviewEnvironment(); addImageNode('asset://localhost/D%3A%5Cprivate%5Coversized.png');
    mocks.lstat.mockResolvedValue({ isFile: true, isSymlink: false, size: 16 * 1024 * 1024 + 1, mtime: new Date(10) });
    const page = await queryPluginPromptMentions({ ...options(), source: 'nodes', preview: true });
    expect(page.items.at(-1)!.thumbnailDataUrl).toBeUndefined(); expect(mocks.open).not.toHaveBeenCalled();
  });
  it('rejects local-file growth using a one-byte probe instead of allocating the grown file', async () => {
    installPreviewEnvironment(); addImageNode('file:///D:/private/changed.png');
    let calls = 0;
    mocks.open.mockResolvedValueOnce({ read: async (target: Uint8Array) => {
      if (++calls === 1) { target.set(png()); return 57; }
      expect(target.length).toBe(1); target[0] = 1; return 1;
    }, close: mocks.close });
    expect((await queryPluginPromptMentions({ ...options(), source: 'nodes', preview: true })).items.at(-1)!.thumbnailDataUrl).toBeUndefined();
    expect(mocks.bitmap).not.toHaveBeenCalled(); expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('accepts rotated JPEG decode dimensions while preserving the pixel bound', async () => {
    installPreviewEnvironment(); addImageNode(dataUrl(jpeg(800, 400), 'image/jpeg'));
    const bitmap = { width: 400, height: 800, close: vi.fn() }; mocks.bitmap.mockResolvedValueOnce(bitmap);
    const page = await queryPluginPromptMentions({ ...options(), source: 'nodes', preview: true });
    expect(page.items.at(-1)!.thumbnailDataUrl).toMatch(/^data:image\/jpeg;base64,/u);
    expect(mocks.canvases[0].drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 80, 160);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it('fails the page if a node image file changes while JPEG encoding is pending', async () => {
    installPreviewEnvironment(); addImageNode('file:///D:/private/image.png');
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    let complete!: () => void;
    mocks.encode.mockImplementationOnce((canvas: { width: number; height: number }, callback: (blob: Blob) => void, type: string) => {
      complete = () => callback(new Blob([jpeg(canvas.width, canvas.height)], { type })); started();
    });
    const query = queryPluginPromptMentions({ ...options(), source: 'nodes', preview: true });
    const failure = expect(query).rejects.toThrow('预览文件已变更');
    await ready; mocks.lstat.mockResolvedValue({ isFile: true, isSymlink: false, size: 57, mtime: new Date(11) }); complete();
    await failure;
  });
  it('caps the full encoded JPEG for every item and the thumbnail payload of a 20-item page', async () => {
    installPreviewEnvironment(); mocks.state.globalCharacters = [];
    mocks.state.dramaAssets = { version: 2, characters: Array.from({ length: 20 }, (_, index) => ({ ...character(String(index)), imageUrl: dataUrl(png(800, 400)), referenceImages: [] })), scenes: [], props: [] };
    mocks.encode.mockImplementation((canvas: { width: number; height: number }, callback: (blob: Blob) => void, type: string) => {
      callback(new Blob([jpeg(canvas.width, canvas.height, canvas.width === 160 ? 9000 : 6000)], { type }));
    });
    const page = await queryPluginPromptMentions({ ...options(), source: 'characters', preview: true });
    expect(page.items).toHaveLength(20); expect(page.items.every((item) => item.thumbnailDataUrl!.length <= 8192)).toBe(true);
    expect(page.items.every((item) => item.thumbnailDataUrl!.length > 8000)).toBe(true);
    expect(page.items.reduce((size, item) => size + item.thumbnailDataUrl!.length, 0)).toBeLessThanOrEqual(160 * 1024);
    expect(mocks.canvases[0].drawImage.mock.calls.map((call) => call.slice(-2))).toEqual([[160, 80], [120, 60]]);
  });
  it('fails the page when lease cleanup races with local file reading and still closes the file', async () => {
    installPreviewEnvironment(); const opts = options();
    mocks.read.mockImplementationOnce(async () => { clearPluginPromptReferences(opts.context.invocationId); });
    await expect(queryPluginPromptMentions({ ...opts, source: 'assets', preview: true })).rejects.toThrow('租约已撤销');
    expect(mocks.close).toHaveBeenCalledOnce(); expect(mocks.bitmap).not.toHaveBeenCalled();
  });
  it('fails rather than returning an image after its source changes during encoding', async () => {
    installPreviewEnvironment(); addImageNode();
    mocks.bitmap.mockImplementationOnce(async () => {
      (mocks.state.nodes as Array<{ data: Record<string, unknown> }>).at(-1)!.data.imageUrl = dataUrl(png(4, 8));
      return { width: 8, height: 4, close: vi.fn() };
    });
    await expect(queryPluginPromptMentions({ ...options(), source: 'nodes', preview: true })).rejects.toThrow('预览来源已变更');
    expect((await mocks.bitmap.mock.results[0].value).close).toHaveBeenCalledOnce();
  });
  it('does not return or cache a late decode after cancellation and closes the bitmap when it arrives', async () => {
    installPreviewEnvironment(); addImageNode(); const opts = options(); const controller = new AbortController();
    let complete!: (bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> }) => void;
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    mocks.bitmap.mockImplementationOnce(() => { started(); return new Promise((resolve) => { complete = resolve; }); });
    const query = queryPluginPromptMentions({ ...opts, source: 'nodes', preview: true, signal: controller.signal });
    await ready; controller.abort();
    await expect(query).rejects.toThrow('已取消');
    const bitmap = { width: 8, height: 4, close: vi.fn() }; complete(bitmap); await Promise.resolve();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(await queryPluginPromptMentions({ ...opts, source: 'nodes' }))).not.toContain('thumbnail');
  });
  it('rejects a revoked lease during decoder waiting and closes its late bitmap', async () => {
    installPreviewEnvironment(); addImageNode(); const opts = options();
    let complete!: (bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> }) => void;
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    mocks.bitmap.mockImplementationOnce(() => { started(); return new Promise((resolve) => { complete = resolve; }); });
    const query = queryPluginPromptMentions({ ...opts, source: 'nodes', preview: true }); await ready;
    clearPluginPromptReferences(opts.context.invocationId);
    const bitmap = { width: 8, height: 4, close: vi.fn() }; complete(bitmap);
    await expect(query).rejects.toThrow('租约已撤销'); expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it('falls back on bounded decoder timeout and disposes the late bitmap', async () => {
    installPreviewEnvironment(); addImageNode('file:///D:/private/image.png');
    let complete!: (bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> }) => void;
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    mocks.bitmap.mockImplementationOnce(() => { started(); return new Promise((resolve) => { complete = resolve; }); });
    vi.useFakeTimers();
    try {
      const query = queryPluginPromptMentions({ ...options(), source: 'nodes', preview: true }); await ready;
      await vi.advanceTimersByTimeAsync(3001);
      const page = await query;
      expect(page.items.at(-1)!.thumbnailDataUrl).toBeUndefined();
      const bitmap = { width: 8, height: 4, close: vi.fn() }; complete(bitmap); await Promise.resolve();
      expect(bitmap.close).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('cancels pending native file-open waiting and closes the late file handle', async () => {
    installPreviewEnvironment(); const controller = new AbortController();
    let complete!: (file: { read: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }) => void;
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    mocks.open.mockImplementationOnce(() => { started(); return new Promise((resolve) => { complete = resolve; }); });
    const query = queryPluginPromptMentions({ ...options(), source: 'assets', preview: true, signal: controller.signal });
    await ready; controller.abort(); await expect(query).rejects.toThrow('已取消');
    const file = { read: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }; complete(file); await Promise.resolve();
    expect(file.close).toHaveBeenCalledOnce(); expect(file.read).not.toHaveBeenCalled();
  });
  it('falls back to icons on ordinary decoder failure without leaking native exception messages', async () => {
    installPreviewEnvironment(); addImageNode(); mocks.bitmap.mockRejectedValueOnce(new Error('failed D:\\private\\secret.png'));
    const page = await queryPluginPromptMentions({ ...options(), source: 'nodes', preview: true });
    expect(page.items.at(-1)!.thumbnailDataUrl).toBeUndefined(); expect(JSON.stringify(page)).not.toContain('private');
  });
  it('stream-reads a host blob URL and refuses an unbounded arrayBuffer fallback', async () => {
    installPreviewEnvironment(); addImageNode('blob:https://host.invalid/known-image');
    const fetch = vi.fn().mockResolvedValue(new Response(png())); vi.stubGlobal('fetch', fetch);
    const page = await queryPluginPromptMentions({ ...options(), source: 'nodes', preview: true });
    expect(page.items.at(-1)!.thumbnailDataUrl).toBeDefined();
    expect(fetch).toHaveBeenCalledWith('blob:https://host.invalid/known-image', { credentials: 'omit', signal: undefined });
    const arrayBuffer = vi.fn(); fetch.mockResolvedValue({ ok: true, body: undefined, arrayBuffer });
    expect((await queryPluginPromptMentions({ ...options(), source: 'nodes', preview: true })).items.at(-1)!.thumbnailDataUrl).toBeUndefined();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
  it('cancels a blob reader as soon as its decoded source-byte limit is exceeded', async () => {
    installPreviewEnvironment(); addImageNode('blob:https://host.invalid/oversized-image');
    const cancel = vi.fn().mockResolvedValue(undefined), releaseLock = vi.fn();
    const read = vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(16 * 1024 * 1024 + 1) });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => ({ read, cancel, releaseLock }) } }));
    expect((await queryPluginPromptMentions({ ...options(), source: 'nodes', preview: true })).items.at(-1)!.thumbnailDataUrl).toBeUndefined();
    expect(read).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce(); expect(mocks.bitmap).not.toHaveBeenCalled();
  });
});
