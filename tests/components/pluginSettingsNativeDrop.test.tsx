/**
 * pluginSettingsNativeDrop — 回归测试：waits for speech dependency preparation after review and before %s installation。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type { DragDropEvent } from '@tauri-apps/api/webview';
import { PhysicalPosition } from '@tauri-apps/api/dpi';

type ElementLike = { props: Record<string, unknown> & { children?: unknown } };
type NativeCallback = (event: { payload: DragDropEvent }) => Promise<void> | void;

function findZone(root: unknown): ElementLike | undefined {
  if (Array.isArray(root)) return root.map(findZone).find(Boolean);
  if (!root || typeof root !== 'object' || !('props' in root)) return undefined;
  const el = root as ElementLike;
  return String(el.props.className).includes('ui-dropzone') ? el : findZone(el.props.children);
}

function findElement(root: unknown, predicate: (props: ElementLike['props']) => boolean): ElementLike | undefined {
  if (Array.isArray(root)) return root.map((child) => findElement(child, predicate)).find(Boolean);
  if (!root || typeof root !== 'object' || !('props' in root)) return undefined;
  const element = root as ElementLike;
  return predicate(element.props) ? element : findElement(element.props.children, predicate);
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.doUnmock('react'); vi.unstubAllGlobals(); });

async function setup(options: { tauri?: boolean; delayedRegistration?: boolean; registrationError?: boolean } = {}) {
  const slots: unknown[] = [];
  let cursor = 0;
  let effects: Array<() => void | (() => void)> = [];
  vi.doMock('react', async () => ({
    ...await vi.importActual<typeof import('react')>('react'),
    useCallback: <T,>(callback: T) => callback,
    useMemo: <T,>(factory: () => T) => factory(),
    useSyncExternalStore: <T,>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
    useEffect: (effect: () => void | (() => void)) => { effects.push(effect); },
    useRef: <T,>(initial: T) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useState: <T,>(initial: T) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next: T | ((previous: T) => T)) => {
        slots[index] = typeof next === 'function' ? (next as (previous: T) => T)(slots[index] as T) : next;
      }];
    },
  }));
  vi.doMock('framer-motion', () => ({ motion: { div: 'div' } }));
  vi.doMock('../../src/components/chat/ChatMarkdown', () => ({ default: () => null }));
  vi.doMock('../../src/components/shared/ModalOverlay', () => ({ default: () => null }));
  const toast = vi.fn();
  const install = vi.fn().mockResolvedValue(undefined);
  const prepareSpeech = vi.fn().mockResolvedValue(true);
  const speechModels = {
    ready: true, isPreparing: false, isDownloading: false, progress: null,
    downloadLabel: undefined, cancel: vi.fn(), prepare: prepareSpeech,
  };
  vi.doMock('../../src/hooks/usePluginSpeechModels', () => ({
    pluginUsesSpeechModels: (manifest: { requiredCapabilities?: string[] }) => manifest.requiredCapabilities?.includes('video.replicaPipeline') === true,
    usePluginSpeechModels: () => speechModels,
  }));
  const paste = vi.fn();
  const store = {
    installedPlugins: [], installPluginBundle: install, showToast: toast,
    pasteExternalFromDataTransfer: paste,
  } as unknown as AppState;
  vi.doMock('../../src/store/useAppStore', () => ({
    useAppStore: Object.assign(<T,>(selector: (state: AppState) => T) => selector(store), { getState: () => store }),
    generateId: () => 'test', computeImageNodeDimensions: vi.fn(),
  }));
  vi.doMock('@xyflow/react', () => ({ useReactFlow: () => ({ screenToFlowPosition: (point: unknown) => point }) }));
  vi.doMock('../../src/services/fileService', () => ({
    isTauriEnv: () => options.tauri !== false,
    saveBinaryToLocalFile: vi.fn(), readBinaryFile: vi.fn(), copyFileToProjectData: vi.fn(), arrayBufferToBase64: vi.fn(),
  }));
  const manifestText = JSON.stringify({
    apiVersion: 1, id: 'com.example.drag', name: '拖放插件', version: '1.0.0',
    category: 'utility', runtime: 'python', entry: 'main.py', permissions: ['node.read', 'node.write'],
    contributes: { nodeTools: [{
      id: 'test', title: '测试', placements: ['node-context-menu'], nodeTypes: ['ai-text'],
      inputFields: ['output'], output: { mode: 'update-current', fields: ['output'] },
    }] },
  });
  const readPackage = vi.fn().mockResolvedValue({
    manifestText, manifest: JSON.parse(manifestText), source: 'define_plugin({"tools": {}})', resourcePayloads: [], directory: 'G:/plugins/example/',
  });
  const resolveGithub = vi.fn().mockResolvedValue({
    manifestText, manifest: JSON.parse(manifestText), source: 'define_plugin({"tools": {}})',
    resourcePayloads: [], repository: 'example/plugin',
  });
  vi.doMock('../../src/services/plugins/pluginMarketplace', async () => ({
    ...await vi.importActual<typeof import('../../src/services/plugins/pluginMarketplace')>('../../src/services/plugins/pluginMarketplace'),
    resolveGithubPlugin: resolveGithub,
    loadPluginMarketplace: vi.fn().mockResolvedValue([]),
  }));
  vi.doMock('../../src/services/fs/pluginPackageFiles', () => ({ readLocalPluginPackage: readPackage, selectNativePluginDirectory: vi.fn() }));
  const confirm = vi.fn().mockResolvedValue(true);
  vi.doMock('../../src/services/confirmDialog', () => ({ confirmAction: confirm }));
  let callback: NativeCallback | undefined;
  let finishRegistration: ((release: () => void) => void) | undefined;
  const release = vi.fn();
  const subscribe = vi.fn(async (handler: NativeCallback) => {
    callback = handler;
    if (options.registrationError) throw new Error('native listener unavailable');
    if (options.delayedRegistration) return new Promise<() => void>((resolve) => { finishRegistration = resolve; });
    return release;
  });
  vi.doMock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: subscribe }) }));
  const globalListen = vi.fn().mockResolvedValue(vi.fn());
  vi.doMock('@tauri-apps/api/event', () => ({ listen: globalListen }));
  vi.stubGlobal('navigator', { platform: 'Win32' });
  vi.stubGlobal('window', { devicePixelRatio: 2, setTimeout: vi.fn(), clearTimeout: vi.fn() });
  const { default: PluginSettings } = await import('../../src/components/settings/PluginSettings');
  const { isExternalDropCaptured } = await import('../../src/utils/dropCapture');
  const renderFull = () => { cursor = 0; effects = []; return PluginSettings(); };
  const render = () => findZone(renderFull())!;
  const zone = render();
  if (zone.props.ref) {
    (zone.props.ref as { current: unknown }).current = {
      getBoundingClientRect: () => ({ left: 100, right: 200, top: 100, bottom: 200 }),
    };
  }
  const cleanups = effects.map((effect) => effect());
  const { useNodeCreation: createNodes } = await import('../../src/hooks/useNodeCreation');
  const canvas = createNodes();
  const dispose = () => cleanups.forEach((cleanup) => cleanup?.());
  if (options.tauri !== false) await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
  return {
    zone, render, readPackage, install, confirm, toast, release, subscribe, globalListen, canvas, paste, manifestText,
    store, renderFull, prepareSpeech, speechModels, resolveGithub,
    isExternalDropCaptured, dispose,
    finishRegistration: () => finishRegistration?.(release),
    send: async (payload: DragDropEvent) => { await callback?.({ payload }); },
  };
}

const drop = (x = 300): DragDropEvent => ({ type: 'drop', paths: ['G:/plugins/example'], position: new PhysicalPosition(x, 300) });

it('imports a protocol-only package through native folder review and displays its contribution', async () => {
  const h = await setup();
  const manifest = { apiVersion: 2 as const, id: 'example.responses', name: 'OpenAI Responses', version: '1.0.0', category: 'utility' as const,
    runtime: 'javascript' as const, entry: 'main.js' as const, permissions: [], requiredCapabilities: ['model.protocolPresets'],
    contributes: { nodeTools: [], modelProtocols: [{ id: 'responses', name: 'OpenAI Responses', category: 'text' as const, adapter: 'openai-responses' as const }] } };
  h.readPackage.mockResolvedValue({ manifestText: JSON.stringify(manifest), manifest, source: 'definePlugin({ tools: {} });', resourcePayloads: [], directory: 'G:/plugins/example/' });
  try {
    await h.send(drop());
    await vi.waitFor(() => expect(h.install).toHaveBeenCalledOnce());
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.install.mock.calls[0][0]).toContain('modelProtocols');
    h.store.installedPlugins = [{ id: manifest.id, enabled: true, manifest, source: '', installedAt: 1, updatedAt: 1 }];
    const text = (root: unknown): string => Array.isArray(root) ? root.map(text).join('')
      : typeof root === 'string' || typeof root === 'number' ? String(root)
        : root && typeof root === 'object' && 'props' in root ? text((root as ElementLike).props.children) : '';
    const content = text(h.renderFull());
    expect(content).toContain('0 个工具 · 0 个自定义节点');
    expect(content).toContain('1 个协议预设');
    expect(content).toContain('协议预设 · OpenAI Responses');
  } finally { h.dispose(); }
});

async function triggerInstall(harness: Awaited<ReturnType<typeof setup>>, entry: 'native' | 'browser' | 'github') {
  if (entry === 'native') { await harness.send(drop()); return; }
  if (entry === 'browser') {
    await (harness.zone.props.onDrop as (event: unknown) => Promise<void>)({
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
      dataTransfer: { items: [], files: [
        { name: 'manifest.json', text: async () => harness.manifestText },
        { name: 'main.py', text: async () => 'define_plugin({"tools": {}})' },
      ] },
    });
    return;
  }
  const repositoryInput = () => findElement(harness.renderFull(), (props) => props['aria-label'] === 'GitHub 插件仓库地址')!;
  (repositoryInput().props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'example/plugin' } });
  (repositoryInput().props.onKeyDown as (event: { key: string }) => void)({ key: 'Enter' });
}

it.each(['native', 'browser', 'github'] as const)('waits for speech dependency preparation after review and before %s installation', async (entry) => {
  const h = await setup({ tauri: entry !== 'browser' });
  let finishPreparation!: (ready: boolean) => void;
  h.prepareSpeech.mockReturnValueOnce(new Promise<boolean>((resolve) => { finishPreparation = resolve; }));
  try {
    const pending = triggerInstall(h, entry);
    await vi.waitFor(() => expect(h.prepareSpeech).toHaveBeenCalledOnce());
    expect(h.confirm).toHaveBeenCalledOnce(); expect(h.install).not.toHaveBeenCalled();
    expect(h.prepareSpeech).toHaveBeenCalledWith(expect.objectContaining({
      id: 'com.example.drag', name: '拖放插件', runtime: 'python',
    }));
    expect(h.confirm.mock.invocationCallOrder[0]).toBeLessThan(h.prepareSpeech.mock.invocationCallOrder[0]);
    finishPreparation(true); await pending;
    await vi.waitFor(() => expect(h.install).toHaveBeenCalledOnce());
    expect(h.prepareSpeech.mock.invocationCallOrder[0]).toBeLessThan(h.install.mock.invocationCallOrder[0]);
    if (entry === 'github') expect(h.resolveGithub).toHaveBeenCalledOnce();
  } finally { h.dispose(); }
});

it.each(['cancelled', 'failed'] as const)('does not stage a plugin when speech dependency preparation is %s', async (outcome) => {
  const h = await setup();
  if (outcome === 'cancelled') h.prepareSpeech.mockResolvedValueOnce(false);
  else h.prepareSpeech.mockRejectedValueOnce(new Error('语音模型下载失败：国内镜像连接超时'));
  try {
    await h.send(drop());
    expect(h.prepareSpeech).toHaveBeenCalledOnce(); expect(h.install).not.toHaveBeenCalled();
    if (outcome === 'failed') expect(h.toast).toHaveBeenCalledWith('语音模型下载失败：国内镜像连接超时', 'error');
    else expect(h.toast).not.toHaveBeenCalled();
  } finally { h.dispose(); }
});

it('keeps the speech download overlay above settings and wires cancellation to its active transfer', async () => {
  const h = await setup();
  h.speechModels.isDownloading = true;
  try {
    const overlay = findElement(h.renderFull(), (props) => props.type === 'asr' && props.showDownloading === true);
    expect(overlay?.props).toMatchObject({ zIndex: 300, showPrompt: false });
    (overlay!.props.onCancel as () => void)();
    expect(h.speechModels.cancel).toHaveBeenCalledOnce();
  } finally { h.dispose(); }
});

it.each(['ready', 'cancelled', 'failed'] as const)('prepares missing speech models from an installed card without reinstalling (%s)', async (outcome) => {
  const h = await setup();
  const manifest = { ...JSON.parse(h.manifestText), apiVersion: 2, requiredCapabilities: ['video.replicaPipeline'] };
  h.store.installedPlugins = [{ id: manifest.id, enabled: true, manifest, source: '',
    sourceDigest: 'a'.repeat(64), revisionDigest: 'b'.repeat(64), installedAt: 1, updatedAt: 1 }];
  h.speechModels.ready = false;
  if (outcome === 'cancelled') h.prepareSpeech.mockResolvedValueOnce(false);
  if (outcome === 'failed') h.prepareSpeech.mockRejectedValueOnce(new Error('语音模型下载失败：国内镜像连接超时'));
  try {
    const prepareButton = findElement(h.renderFull(), (props) => Array.isArray(props.children)
      && props.children.includes('准备语音模型'));
    expect(prepareButton).toBeDefined();
    (prepareButton!.props.onClick as () => void)();
    await vi.waitFor(() => expect(h.prepareSpeech).toHaveBeenCalledExactlyOnceWith(manifest, false));
    if (outcome === 'ready') await vi.waitFor(() => expect(h.toast).toHaveBeenCalledExactlyOnceWith('语音模型已就绪'));
    if (outcome === 'failed') await vi.waitFor(() => expect(h.toast).toHaveBeenCalledExactlyOnceWith('语音模型下载失败：国内镜像连接超时', 'error'));
    if (outcome === 'cancelled') expect(h.toast).not.toHaveBeenCalled();
    if (outcome !== 'ready') expect(h.toast).not.toHaveBeenCalledWith('语音模型已就绪');
    expect(h.install).not.toHaveBeenCalled(); expect(h.confirm).not.toHaveBeenCalled();
  } finally { h.dispose(); }
});

it('accepts a Finder folder inside the plugin zone on a Retina Mac', async () => {
  const h = await setup();
  vi.stubGlobal('navigator', { platform: 'MacIntel' });
  try {
    await h.send({ type: 'enter', paths: ['/Users/example/plugin'], position: new PhysicalPosition(150, 150) });
    expect(h.render().props.className).toContain('is-dragover');
    await h.send({ type: 'drop', paths: ['/Users/example/plugin'], position: new PhysicalPosition(150, 150) });
    expect(h.readPackage).toHaveBeenCalledExactlyOnceWith(['/Users/example/plugin'], true);
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.install).toHaveBeenCalledOnce();
  } finally { h.dispose(); }
});

it('labels each entry with its declared node type without mixing placements from different tools', async () => {
  const h = await setup();
  const manifest = JSON.parse(h.manifestText);
  const tool = manifest.contributes.nodeTools[0];
  manifest.contributes.nodeTools = [
    { ...tool, nodeTypes: ['source-text'], placements: ['node-context-menu', 'node-toolbar'] },
    { ...tool, id: 'image', nodeTypes: ['source-image'], placements: ['node-context-menu'] },
    { ...tool, id: 'duplicate', nodeTypes: ['source-text'], placements: ['node-context-menu'] },
  ];
  manifest.contributes.nodes = [{ id: 'custom', title: '自定义节点' }];
  h.store.installedPlugins = [{ id: manifest.id, enabled: true, manifest, source: '', installedAt: 1, updatedAt: 1 }];
  const text = (root: unknown): string => {
    if (Array.isArray(root)) return root.map(text).join('');
    if (typeof root === 'string' || typeof root === 'number') return String(root);
    if (root && typeof root === 'object' && 'props' in root) return text((root as ElementLike).props.children);
    return '';
  };
  try {
    const content = text(h.renderFull());
    expect(content).toContain('入口：文本节点右键菜单、文本节点工具栏、图像节点右键菜单、节点选择器');
    expect(content).not.toContain('图像节点工具栏');
    expect(content).not.toContain('source-text');
    expect(content).not.toContain('source-image');
  } finally { h.dispose(); }
});

it('receives a native folder drop at scaled coordinates and uses the existing reviewed installation chain', async () => {
  const h = await setup();
  try {
    await h.send({ type: 'enter', paths: ['G:/plugins/example'], position: new PhysicalPosition(300, 300) });
    expect(h.render().props.className).toContain('is-dragover');
    await h.send(drop());
    await vi.waitFor(() => expect(h.install).toHaveBeenCalledOnce());
    expect(h.readPackage).toHaveBeenCalledExactlyOnceWith(['G:/plugins/example'], true);
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.render().props.className).not.toContain('is-dragover');
    expect(h.globalListen).not.toHaveBeenCalled();
    const readDuplicate = vi.fn().mockResolvedValue(h.manifestText);
    (h.zone.props.onDrop as (event: unknown) => void)({
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
      dataTransfer: { items: [], files: [{ name: 'manifest.json', text: readDuplicate }] },
    });
    expect(readDuplicate).not.toHaveBeenCalled();
    expect(h.install).toHaveBeenCalledOnce();
  } finally { h.dispose(); }
});

it('reloads only a successfully installed local directory through the reviewed installation path and rejects changed IDs', async () => {
  const h = await setup();
  const findReload = (root: unknown): ElementLike | undefined => {
    if (Array.isArray(root)) return root.map(findReload).find(Boolean);
    if (!root || typeof root !== 'object' || !('props' in root)) return undefined;
    const element = root as ElementLike;
    return String(element.props['aria-label']).startsWith('重新载入 ') ? element : findReload(element.props.children);
  };
  h.install.mockImplementation(async () => {
    h.store.installedPlugins = [{ id: 'com.example.drag', enabled: true, manifest: JSON.parse(h.manifestText),
      source: '', sourceDigest: 'a'.repeat(64), revisionDigest: 'b'.repeat(64), installedAt: 1, updatedAt: 1 }];
  });
  try {
    await h.send(drop());
    const button = findReload(h.renderFull())!;
    expect(button).toBeDefined();
    await (button.props.onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(h.install).toHaveBeenCalledTimes(2));
    expect(h.readPackage).toHaveBeenLastCalledWith(['G:/plugins/example/'], true);
    expect(h.install).toHaveBeenCalledTimes(2);
    expect(h.confirm).toHaveBeenCalledTimes(2);
    h.readPackage.mockResolvedValueOnce({
      manifestText: h.manifestText, manifest: { ...JSON.parse(h.manifestText), id: 'com.example.other' },
      source: '', resourcePayloads: [], directory: 'G:/plugins/example/',
    });
    await (findReload(h.renderFull())!.props.onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.stringContaining('插件 ID 已变化'), 'error'));
    expect(h.install).toHaveBeenCalledTimes(2);
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining('插件 ID 已变化'), 'error');
  } finally { h.dispose(); }
});

it('clears native hover on leave and ignores drops outside the zone', async () => {
  const h = await setup();
  try {
    await h.send({ type: 'over', position: new PhysicalPosition(300, 300) });
    expect(h.render().props.className).toContain('is-dragover');
    await h.send({ type: 'leave' });
    expect(h.render().props.className).not.toContain('is-dragover');
    await h.send(drop(500));
    expect(h.readPackage).not.toHaveBeenCalled();
  } finally { h.dispose(); }
});

it('accepts only one native installation while reading or awaiting review', async () => {
  const h = await setup();
  let approve!: (value: boolean) => void;
  h.confirm.mockReturnValueOnce(new Promise<boolean>((resolve) => { approve = resolve; }));
  try {
    const first = h.send(drop());
    await vi.waitFor(() => expect(h.confirm).toHaveBeenCalledOnce());
    await h.send(drop());
    expect(h.readPackage).toHaveBeenCalledOnce();
    approve(false);
    await first;
    expect(h.install).not.toHaveBeenCalled();
  } finally { h.dispose(); }
});

it('blocks canvas browser drops while open and restores them after listener cleanup', async () => {
  const h = await setup();
  const event = {
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
    dataTransfer: { files: [{}] }, clientX: 150, clientY: 150,
  };
  try {
    expect(h.isExternalDropCaptured()).toBe(true);
    await h.canvas.onDrop(event as unknown as React.DragEvent);
    expect(h.paste).not.toHaveBeenCalled();
  } finally { h.dispose(); }
  expect(h.release).toHaveBeenCalledOnce();
  expect(h.isExternalDropCaptured()).toBe(false);
  await h.send(drop());
  expect(h.readPackage).not.toHaveBeenCalled();
  await h.canvas.onDrop(event as unknown as React.DragEvent);
  expect(h.paste).toHaveBeenCalledOnce();
});

it('releases registration that finishes after the panel closes', async () => {
  const h = await setup({ delayedRegistration: true });
  h.dispose();
  h.finishRegistration();
  await vi.waitFor(() => expect(h.release).toHaveBeenCalledOnce());
  await h.send(drop());
  expect(h.readPackage).not.toHaveBeenCalled();
  expect(h.isExternalDropCaptured()).toBe(false);
});

it('keeps browser drag-and-drop available without registering a native listener', async () => {
  const h = await setup({ tauri: false });
  const event = {
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
    dataTransfer: { items: [], files: [
      { name: 'manifest.json', text: async () => h.manifestText },
      { name: 'main.py', text: async () => 'define_plugin({"tools": {}})' },
    ] },
  };
  try {
    await (h.zone.props.onDrop as (event: unknown) => void)(event);
    await vi.waitFor(() => expect(h.install).toHaveBeenCalledOnce());
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(h.subscribe).not.toHaveBeenCalled();
    expect(h.isExternalDropCaptured()).toBe(true);
  } finally { h.dispose(); }
});

it('reports native registration failure so the user can use the directory picker', async () => {
  const h = await setup({ registrationError: true });
  try {
    await vi.waitFor(() => expect(h.toast).toHaveBeenCalledWith('拖放接收不可用，请点击选择插件文件夹', 'error'));
    expect(h.readPackage).not.toHaveBeenCalled();
  } finally { h.dispose(); }
});

it('reports an invalid folder dropped inside the zone instead of silently ignoring it', async () => {
  const h = await setup();
  h.readPackage.mockRejectedValueOnce(new Error('所选文件夹根目录缺少 manifest.json，请选择插件根目录'));
  try {
    await h.send(drop());
    expect(h.toast).toHaveBeenCalledWith('所选文件夹根目录缺少 manifest.json，请选择插件根目录', 'error');
    expect(h.install).not.toHaveBeenCalled();
    expect(h.render().props.className).not.toContain('is-dragover');
  } finally { h.dispose(); }
});
