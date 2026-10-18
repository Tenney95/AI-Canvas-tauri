import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createHash } from 'node:crypto';
import type { AppState } from '../../src/store/useAppStore';


type Element = { props: Record<string, unknown> };
const driver = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, state: () => ({} as AppState),
  patch: (_partial: Partial<AppState>) => {},
  listProjects: vi.fn(), loadProject: vi.fn(), saveProject: vi.fn(),
  saveCurrentProject: vi.fn(), toast: vi.fn(),
  native: false, secrets: new Map<string, string>(), invoke: vi.fn(),
  exportJson: vi.fn(), readJson: vi.fn(),
}));
// 执行真实按钮事件和 Store / IndexedDB；不挂载余额查询及其他窗口副作用。
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const index = driver.cursor++;
    if (!(index in driver.slots)) driver.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [driver.slots[index], (next: T | ((old: T) => T)) => {
      driver.slots[index] = typeof next === 'function' ? (next as (old: T) => T)(driver.slots[index] as T) : next;
    }];
  },
  useRef: <T,>(initial: T) => {
    const index = driver.cursor++;
    driver.slots[index] ??= { current: initial };
    return driver.slots[index];
  },
  useEffect: () => {}, useMemo: <T,>(fn: () => T) => fn(), useCallback: <T,>(fn: T) => fn,
  useSyncExternalStore: <T,>(_subscribe: unknown, snapshot: () => T) => snapshot(),
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
// 本用例按中文原文定位按钮与提示（data-tooltip / aria-label / toast 文案）。
// 直接返回 key，避免运行环境的系统语言不同导致文案被翻译后找不到元素。
vi.mock('../../src/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/i18n')>()),
  useT: () => (text: string, params?: Record<string, string | number>) => Object.entries(params || {})
    .reduce((value, [key, replacement]) => value.replaceAll(`{${key}}`, String(replacement)), text),
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign(<T,>(selector: (state: AppState) => T) => selector(driver.state()), { getState: () => driver.state() }),
}));
vi.mock('@iconify/react', () => ({ Icon: 'icon' }));
vi.mock('@tauri-apps/api/core', async (original) => ({
  ...await original<typeof import('@tauri-apps/api/core')>(), invoke: driver.invoke,
}));
vi.mock('../../src/components/shared/AnimatedButton', () => ({ default: 'button' }));
vi.mock('../../src/components/shared/ProviderBadge', () => ({ default: 'badge' }));
vi.mock('../../src/components/settings/ProviderConnectionDialog', () => ({ default: 'dialog' }));
vi.mock('../../src/components/settings/DreaminaLoginModal', () => ({ default: 'dreamina' }));
vi.mock('../../src/components/nodes/shared/defaultModels', () => ({ defaultModelGroups: [] }));
vi.mock('../../src/services/workflowApi/workflowApiConfig', () => ({ saveWorkflowApiDrafts: vi.fn(), saveAutodlWorkflowTemplate: vi.fn() }));
vi.mock('../../src/services/fs/core', () => ({
  isTauriEnv: () => driver.native, getProjectDataDir: async () => null,
  joinPath: (...parts: string[]) => parts.join('/'),
}));
vi.mock('../../src/services/fileService', async () => ({
  ...await vi.importActual<typeof import('../../src/services/storageService')>('../../src/services/storageService'),
  loadProjectsList: driver.listProjects, loadProjectData: driver.loadProject,
  saveProject: driver.saveProject, setBaseDataDir: vi.fn(), syncAuthorizedDirectories: async () => {},
  exportJsonTextFile: driver.exportJson, readJsonTextFile: driver.readJson,
  JsonFileTransferError: (await vi.importActual<typeof import('../../src/services/fs/jsonFileTransfer')>('../../src/services/fs/jsonFileTransfer')).JsonFileTransferError,
}));

import ApiKeySettings from '../../src/components/settings/ApiKeySettings';
import { createConfigSlice } from '../../src/store/store.config';
import { loadConfigFromDb, saveConfigToDb } from '../../src/services/indexedDbService';
import { serializeConnection } from '../../src/services/ai/providerConnectionTransfer';
import { JsonFileTransferError } from '../../src/services/fs/jsonFileTransfer';
import type { RunningHubSiteKeyDrafts } from '../../src/types/runninghub';
import { runningHubConnection } from '../../src/services/workflowExecutionService';

function configStore() {
  return createStore<AppState>()((set, get, api) => ({
    ...createConfigSlice(set, get, api), showToast: driver.toast,
    nodes: [], projects: [], workflows: [], currentProjectId: null,
    pendingApiKeyConnectionId: null, setPendingApiKeyConnectionId: vi.fn(),
    commitToHistory: vi.fn(), saveCurrentProjectSilent: driver.saveCurrentProject,
  } as unknown as AppState));
}

function find(root: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(root)) return root.map((child) => find(child, predicate)).find(Boolean);
  if (!root || typeof root !== 'object' || !('props' in root)) return undefined;
  const element = root as Element;
  return predicate(element) ? element : find(element.props.children, predicate);
}

function render() {
  driver.cursor = 0;
  return ApiKeySettings({ onClose: vi.fn() });
}

function findAll(root: unknown, predicate: (element: Element) => boolean): Element[] {
  if (Array.isArray(root)) return root.flatMap((child) => findAll(child, predicate));
  if (!root || typeof root !== 'object' || !('props' in root)) return [];
  const element = root as Element;
  return [...(predicate(element) ? [element] : []), ...findAll(element.props.children, predicate)];
}

function addCccGroups() {
  driver.state().saveProviderConfig('cccapi-free', { name: 'CCC API · CCC生图白嫖', catalogId: 'cccapi', cccGroup: 'CCC生图白嫖', apiKey: '',
    selectedModels: [{ id: 'gpt-image-2', name: 'GPT Image 2', category: 'image', provider: 'cccapi-free' }],
  });
  driver.state().saveProviderConfig('cccapi-pro', { name: 'CCC API · GPT-特价Pro', catalogId: 'cccapi', cccGroup: 'GPT-特价Pro', apiKey: 'pro-fixture',
    selectedModels: [{ id: 'gpt-5.6-sol', name: 'GPT', category: 'text', provider: 'cccapi-pro' }],
  });
}

async function clickDelete() {
  const remove = find(render(), (element) => element.props['data-tooltip'] === '删除连接');
  expect(remove).toBeDefined();
  (remove!.props.onClick as () => void)();
  const confirm = find(render(), (element) => element.props['aria-label'] === '确认删除');
  expect(confirm).toBeDefined();
  (confirm!.props.onClick as () => void)();
  await vi.waitFor(() => expect(driver.toast).toHaveBeenCalled());
}

beforeEach(async () => {
  driver.slots = [];
  driver.native = false; driver.secrets.clear();
  driver.invoke.mockReset().mockImplementation(async (command: string, args: { key: string; value?: string; fingerprintOnly?: boolean; expected?: { fingerprint?: string } }) => {
    if (command === 'secret_store_available') return true;
    const current = driver.secrets.get(args.key) ?? null;
    const fingerprint = current === null ? null : createHash('sha256').update(current).digest('hex');
    if (command === 'secret_get') return args.fingerprintOnly ? fingerprint : current;
    if (command === 'secret_set') { driver.secrets.set(args.key, args.value!); return; }
    if (command === 'secret_delete') {
      if (current !== null && args.expected?.fingerprint && args.expected.fingerprint !== fingerprint) throw { code: 'conflict' };
      driver.secrets.delete(args.key); return;
    }
    throw new Error('测试未声明的原生命令');
  });
  driver.listProjects.mockReset().mockResolvedValue([]);
  driver.loadProject.mockReset().mockResolvedValue(null);
  driver.saveProject.mockReset().mockResolvedValue('project');
  driver.saveCurrentProject.mockReset().mockResolvedValue('current');
  driver.toast.mockReset();
  driver.exportJson.mockReset().mockResolvedValue(true);
  driver.readJson.mockReset();
  vi.stubGlobal('window', {});
  await saveConfigToDb({
    providers: {
      'custom-1': { name: '待删除连接', apiKey: '', catalogId: 'custom-openai', baseUrl: 'https://example.test/v1' },
      'custom-2': { name: '保留连接', apiKey: '', catalogId: 'custom-openai', baseUrl: 'https://other.test/v1' },
    },
    generalModels: [
      { id: 'removed-model', name: '待删除模型', modelId: 'model-a', category: 'text', providerConfigId: 'custom-1' },
      { id: 'kept-model', name: '保留模型', modelId: 'model-b', category: 'text', providerConfigId: 'custom-2' },
    ],
  });
  const store = configStore();
  await store.getState().loadConfig();
  driver.state = store.getState;
  driver.patch = store.setState;
  driver.toast.mockClear();
});

describe('连接卡片快捷切换站点', () => {
  function siteButton(provider: string, site: string) {
    return find(render(), (element) => element.props['aria-label'] === `${provider} · ${site}`)!;
  }

  function addToapis() {
    driver.state().saveProviderConfig('toapis', { name: 'ToAPIs', catalogId: 'toapis', apiKey: 'shared-fixture',
      baseUrl: 'https://toapis.cn/v1', selectedModels: [{ id: 'gpt-6.1-sol', name: 'GPT 6.1',
        category: 'text', provider: 'toapis', executionProfile: { preset: 'openai-chat' } }],
    });
  }

  it('ToAPIs 往返切换后保持共享 Key、模型身份和协议，重启恢复所选站点', async () => {
    driver.native = true;
    addToapis();
    const originalModel = driver.state().config.generalModels!.find((model) => model.providerConfigId === 'toapis');
    expect(siteButton('ToAPIs', '国内站（toapis.cn）').props['aria-pressed']).toBe(true);
    for (const [label, baseUrl] of [
      ['国际站（toapis.com）', 'https://toapis.com/v1'],
      ['国内站（toapis.cn）', 'https://toapis.cn/v1'],
    ]) {
      await (siteButton('ToAPIs', label).props.onClick as () => Promise<void>)();
      expect(siteButton('ToAPIs', label).props['aria-pressed']).toBe(true);
      expect(driver.state().config.providers.toapis).toMatchObject({ apiKey: 'shared-fixture', baseUrl });
      expect(driver.state().config.generalModels!.find((model) => model.providerConfigId === 'toapis')).toEqual(originalModel);
      const fresh = configStore();
      await fresh.getState().loadConfig();
      expect(fresh.getState().config.providers.toapis).toMatchObject({ apiKey: 'shared-fixture', baseUrl });
      expect(JSON.stringify(await loadConfigFromDb())).not.toContain('shared-fixture');
    }
    expect(find(render(), (element) => 'onSave' in element.props)!.props.isOpen).toBe(false);
  });

  it.each(['', 'cn-model-fixture'])('RunningHub 从旧入口切换时保留各站独立凭据，原模型 Key=%s', async (modelKey) => {
    driver.native = true;
    if (modelKey) driver.state().saveProviderConfig('runninghub-model', { name: 'RunningHub', catalogId: 'runninghub-model',
      apiKey: modelKey, baseUrl: 'https://www.runninghub.cn/openapi/v2' });
    // 无模型连接时使用设置页既有的“仅工作流”卡片。
    driver.state().saveProviderConfig('runninghub', { name: 'RunningHub 工作流', apiKey: 'cn-workflow-fixture',
      baseUrl: 'https://www.runninghub.cn/openapi/v2' });
    await driver.state().saveConfig({ silent: true });
    await (siteButton('RunningHub', '国际站（runninghub.ai）').props.onClick as () => Promise<void>)();
    expect(driver.state().config.providers['runninghub-model']).toMatchObject({ apiKey: '', baseUrl: 'https://www.runninghub.ai/openapi/v2' });
    expect(driver.state().config.providers.runninghub).toMatchObject({ apiKey: '', baseUrl: 'https://www.runninghub.ai/openapi/v2' });
    expect(siteButton('RunningHub', '国内站（runninghub.cn）')).toBeDefined();
    expect(siteButton('RunningHub', '国际站（runninghub.ai）').props['aria-pressed']).toBe(true);
    expect(find(render(), (element) => element.props.children === '0/2 密钥已配置')).toBeDefined();
    const fresh = configStore();
    await fresh.getState().loadConfig();
    expect(fresh.getState().config.providers['runninghub-model'].apiKey).toBe('');
    expect(fresh.getState().config.providers.runninghub.apiKey).toBe('');
    await (siteButton('RunningHub', '国内站（runninghub.cn）').props.onClick as () => Promise<void>)();
    expect(driver.state().config.providers['runninghub-model'].apiKey).toBe(modelKey);
    expect(runningHubConnection(driver.state().config.providers, 'runninghub').apiKey).toBe('cn-workflow-fixture');
    expect(siteButton('RunningHub', '国内站（runninghub.cn）').props['aria-pressed']).toBe(true);
    expect(JSON.stringify(await loadConfigFromDb())).not.toContain('cn-workflow-fixture');
  });

  it('保存失败保留待保存站点和 Key，解除按钮锁定后可重试保存', async () => {
    driver.native = true;
    addToapis();
    await driver.state().saveConfig({ silent: true });
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    driver.toast.mockClear();
    await (siteButton('ToAPIs', '国际站（toapis.com）').props.onClick as () => Promise<void>)();
    expect(driver.state()).toMatchObject({ configDirty: true, configSaveStatus: 'error' });
    expect(driver.state().config.providers.toapis).toMatchObject({ apiKey: 'shared-fixture', baseUrl: 'https://toapis.com/v1' });
    expect(driver.toast).toHaveBeenCalledWith(expect.any(String), 'error');
    expect(siteButton('ToAPIs', '国内站（toapis.cn）').props.disabled).toBe(false);
    expect(await loadConfigFromDb()).toMatchObject({ providers: { toapis: { baseUrl: 'https://toapis.cn/v1' } } });
    await driver.state().saveConfig({ silent: true });
    const fresh = configStore();
    await fresh.getState().loadConfig();
    expect(fresh.getState().config.providers.toapis).toMatchObject({ apiKey: 'shared-fixture', baseUrl: 'https://toapis.com/v1' });
  });
});

describe('API Key 连接删除持久化', () => {
  it.each(['', 'model-fixture'])('RunningHub 保存工作流密钥时保留国际站点，模型 Key=%s', async (modelKey) => {
    driver.native = true;
    const dialog = find(render(), (element) => typeof element.props.onSave === 'function' && 'runninghubWorkflowApiKey' in element.props);
    expect(dialog).toBeDefined();
    await (dialog!.props.onSave as (id: string, config: AppState['config']['providers'][string], related: { runninghubSiteKeys: RunningHubSiteKeyDrafts }) => Promise<void>)(
      'runninghub-model',
      { name: 'RunningHub', catalogId: 'runninghub-model', apiKey: modelKey, baseUrl: 'https://www.runninghub.ai/openapi/v2' },
      { runninghubSiteKeys: { cn: { modelKey: 'cn-model-fixture', workflowKey: 'cn-workflow-fixture' }, ai: { modelKey, workflowKey: 'workflow-fixture' } } },
    );
    const saved = await loadConfigFromDb();
    expect(saved).toMatchObject({ providers: {
      runninghub: { baseUrl: 'https://www.runninghub.ai/openapi/v2' },
      'runninghub-model': { baseUrl: 'https://www.runninghub.ai/openapi/v2' },
    } });
    const fresh = configStore();
    await fresh.getState().loadConfig();
    expect(fresh.getState().config.providers.runninghub.baseUrl).toBe('https://www.runninghub.ai/openapi/v2');
    expect(runningHubConnection(fresh.getState().config.providers, 'runninghub').apiKey).toBe('workflow-fixture');
    if (modelKey) expect(runningHubConnection(fresh.getState().config.providers, 'runninghub-model').apiKey).toBe(modelKey);
    else expect(() => runningHubConnection(fresh.getState().config.providers, 'runninghub-model')).toThrow('模型');
    fresh.getState().setProviderConfig('runninghub', { baseUrl: 'https://www.runninghub.cn/openapi/v2' });
    fresh.getState().setProviderConfig('runninghub-model', { baseUrl: 'https://www.runninghub.cn/openapi/v2' });
    expect(runningHubConnection(fresh.getState().config.providers, 'runninghub').apiKey).toBe('cn-workflow-fixture');
    await fresh.getState().saveConfig({ silent: true });
    const restarted = configStore();
    await restarted.getState().loadConfig();
    expect(runningHubConnection(restarted.getState().config.providers, 'runninghub-model').apiKey).toBe('cn-model-fixture');
    expect(JSON.stringify(await loadConfigFromDb())).not.toContain('cn-model-fixture');
  });

  it.each(['正常清理', '项目列表读取失败', '项目内容读取失败', '当前项目保存失败'])(
    '%s 时删除自定义连接，重新加载不会恢复连接或模型', async (scenario) => {
      if (scenario === '项目列表读取失败') driver.listProjects.mockRejectedValueOnce(new Error('private fixture'));
      if (scenario === '项目内容读取失败') {
        driver.listProjects.mockResolvedValueOnce([{ id: 'other-project' }]);
        driver.loadProject.mockRejectedValueOnce(new Error('private fixture'));
      }
      if (scenario === '当前项目保存失败') {
        driver.patch({ currentProjectId: 'current', nodes: [{ id: 'node', type: 'ai-text', position: { x: 0, y: 0 }, data: {
          type: 'ai-text', label: '模型节点', model: 'general/removed-model', provider: 'general',
        } }] });
        driver.saveCurrentProject.mockRejectedValueOnce(new Error('private fixture'));
      }
      await clickDelete();
      const saved = await loadConfigFromDb();
      expect(saved).not.toHaveProperty('providers.custom-1');
      expect(saved).toHaveProperty('providers.custom-2');
      const fresh = configStore();
      await fresh.getState().loadConfig();
      expect(fresh.getState().config.providers).not.toHaveProperty('custom-1');
      expect(fresh.getState().config.generalModels?.map((model) => model.id)).toEqual(['kept-model']);
      if (scenario !== '正常清理') {
        expect(driver.toast).toHaveBeenCalledWith('连接已删除，但部分项目的模型引用清理失败，请检查相关项目', 'error');
      }
      expect(JSON.stringify(driver.toast.mock.calls)).not.toContain('private fixture');
    },
  );

  it('数据库提交失败时保留待保存删除并报告失败，重试成功后重新加载不会恢复', async () => {
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await clickDelete();
    expect(driver.state()).toMatchObject({ configDirty: true, configSaveStatus: 'error' });
    expect(await loadConfigFromDb()).toHaveProperty('providers.custom-1');
    expect(driver.toast).not.toHaveBeenCalledWith('连接已删除', 'success');
    await driver.state().saveConfig();
    const fresh = configStore();
    await fresh.getState().loadConfig();
    expect(fresh.getState().config.providers).not.toHaveProperty('custom-1');
    expect(fresh.getState().config.generalModels?.map((model) => model.id)).toEqual(['kept-model']);
  });
});

describe('自定义连接 JSON 文件入口', () => {
  function importInput() {
    return find(render(), (element) => element.props.type === 'file')!;
  }

  async function chooseFile(file?: File) {
    const target = { files: file ? [file] : [], value: file ? 'config.json' : '' };
    await (importInput().props.onChange as (event: unknown) => Promise<void>)({ currentTarget: target });
    expect(target.value).toBe(''); // 同一文件可重新选择。
  }

  it('自定义连接按钮导出脱敏 JSON，取消或失败不会报成功', async () => {
    driver.state().setProviderConfig('custom-1', { apiKey: 'private-fixture' });
    const exportButton = () => find(render(), (element) => element.props['aria-label'] === '导出 待删除连接 JSON')!;
    expect(exportButton().props['data-tooltip']).toBe('导出 JSON（不含 API Key）');
    (exportButton().props.onClick as () => void)();
    await vi.waitFor(() => expect(driver.toast).toHaveBeenCalledWith('连接配置已导出（不含 API Key）', 'success'));
    expect(driver.exportJson).toHaveBeenCalledWith(expect.any(String), '待删除连接');
    expect(driver.exportJson.mock.calls[0][0]).not.toContain('private-fixture');
    driver.toast.mockClear();
    driver.exportJson.mockResolvedValueOnce(false);
    (exportButton().props.onClick as () => void)();
    await vi.waitFor(() => expect(driver.exportJson).toHaveBeenCalledTimes(2));
    expect(driver.toast).not.toHaveBeenCalled();
    driver.exportJson.mockRejectedValueOnce(new Error('private path fixture'));
    (exportButton().props.onClick as () => void)();
    await vi.waitFor(() => expect(driver.toast).toHaveBeenCalledWith('导出 JSON 文件失败', 'error'));
    expect(JSON.stringify(driver.toast.mock.calls)).not.toContain('private path fixture');
  });

  it('上传文件保留图片参数能力，重写模型身份并持久化，等待补 Key', async () => {
    const capability = { resolutions: ['1K', '2K', '4K'], defaultResolution: '2K', ratios: ['1:1', '16:9'],
      defaultRatio: '16:9', supportsBatch: true, maxBatchCount: 4, supportsImageReference: true, maxImageReferences: 10 };
    driver.readJson.mockResolvedValue(serializeConnection({ name: '导入图片', catalogId: 'custom-openai', apiKey: 'excluded',
      baseUrl: 'https://custom.example/v1', selectedModels: [{ id: 'image-fixture', name: '图片', category: 'image',
        provider: 'old-identity', imageCapability: capability }] }));
    const file = new File(['fixture'], 'config.json');
    await chooseFile(file);
    expect(driver.readJson).toHaveBeenCalledWith(file);
    const entry = Object.entries(driver.state().config.providers).find(([, connection]) => connection.name === '导入图片')!;
    const [id, connection] = entry;
    expect(connection.apiKey).toBe('');
    expect(connection.selectedModels![0]).toMatchObject({ provider: id, imageCapability: capability });
    expect(driver.state().setPendingApiKeyConnectionId).toHaveBeenCalledWith(id);
    const fresh = configStore();
    await fresh.getState().loadConfig();
    expect(fresh.getState().config.providers[id].selectedModels![0].imageCapability).toEqual(capability);
  });

  it('取消选择不读文件，内置连接和非法 JSON 不改变配置', async () => {
    const before = Object.keys(driver.state().config.providers);
    await chooseFile();
    expect(driver.readJson).not.toHaveBeenCalled();
    driver.readJson.mockResolvedValueOnce('{');
    await chooseFile(new File(['{'], 'bad.json'));
    expect(driver.toast).toHaveBeenCalledWith('文件里没有有效的连接配置', 'error');
    driver.readJson.mockResolvedValueOnce(serializeConnection({ name: '内置连接', catalogId: 'cccapi', apiKey: '' }));
    await chooseFile(new File(['fixture'], 'ccc.json'));
    expect(driver.toast).toHaveBeenCalledWith('该连接类型不支持导入', 'error');
    expect(Object.keys(driver.state().config.providers)).toEqual(before);
  });

  it.each([
    ['too-large', 'JSON 文件不能超过 8 MiB'], ['invalid-utf8', '文件必须使用 UTF-8 编码'],
  ] as const)('文件读取错误 %s 给出提示且不保存', async (code, message) => {
    const before = Object.keys(driver.state().config.providers);
    driver.readJson.mockRejectedValueOnce(new JsonFileTransferError(code));
    await chooseFile(new File(['fixture'], 'bad.json'));
    expect(driver.toast).toHaveBeenCalledWith(message, 'error');
    expect(Object.keys(driver.state().config.providers)).toEqual(before);
  });
});

describe('CCC 统一管理入口', () => {
  it('多组仅显示一张 CCC 卡片，汇总配置状态并从统一入口编辑全部分组', () => {
    addCccGroups();
    const cards = findAll(render(), (element) => typeof element.props.className === 'string'
      && element.props.className.split(' ').includes('provider-connection-card'));
    expect(cards).toHaveLength(3); // 两个自定义连接和一个 CCC 入口。
    const ccc = cards.filter((card) => find(card.props.children, (element) => element.props.children === 'CCC API'));
    expect(ccc).toHaveLength(1);
    expect(find(ccc[0], (element) => element.props.children === '1/2 组已配置')).toBeDefined();
    expect(find(ccc[0], (element) => element.props.children === '2 个模型')).toBeDefined();
    expect(find(ccc[0], (element) => element.props.children === '2 个分组')).toBeDefined();
    expect(find(ccc[0], (element) => element.props['aria-label'] === '删除 CCC API 全部分组')).toBeDefined();
    expect(find(ccc[0], (element) => element.props['data-tooltip'] === '复制配置（不含 API Key）')).toBeUndefined();
    (find(ccc[0], (element) => element.props['aria-label'] === '管理 CCC 分组')!.props.onClick as () => void)();
    const dialog = find(render(), (element) => 'onSaveCccGroups' in element.props)!;
    expect(dialog.props.isOpen).toBe(true);
    expect(dialog.props.providerConfigs).toBe(driver.state().config.providers);
    expect(driver.state().config.providers['cccapi-pro'].apiKey).toBe('pro-fixture');
    expect(dialog.props.onCopyCccGroup).toBeTypeOf('function');
    expect(dialog.props.onRemoveCccGroup).toBeTypeOf('function');
  });

  it('外层删除需确认全部分组，取消不修改配置，确认后清理全部 CCC 配置、凭据与模型', async () => {
    addCccGroups();
    driver.native = true;
    await driver.state().saveConfig();
    expect([...driver.secrets.values()]).toContain('pro-fixture');
    const requestRemoval = () => {
      const remove = find(render(), (element) => element.props['aria-label'] === '删除 CCC API 全部分组');
      expect(remove).toBeDefined();
      (remove!.props.onClick as () => void)();
    };
    requestRemoval();
    expect(find(render(), (element) => element.props.children === '移除全部 2 个 CCC 分组及其模型配置？')).toBeDefined();
    expect(driver.state().config.providers).toHaveProperty('cccapi-free');
    expect(driver.state().config.providers).toHaveProperty('cccapi-pro');
    (find(render(), (element) => element.props['aria-label'] === '取消删除')!.props.onClick as () => void)();
    expect(find(render(), (element) => element.props['aria-label'] === '确认删除')).toBeUndefined();
    requestRemoval();
    (find(render(), (element) => element.props['aria-label'] === '确认删除')!.props.onClick as () => void)();
    await vi.waitFor(() => expect(driver.toast).toHaveBeenCalledWith('连接已删除', 'success'));
    const fresh = configStore();
    await fresh.getState().loadConfig();
    expect(Object.keys(fresh.getState().config.providers).sort()).toEqual(['custom-1', 'custom-2']);
    expect(fresh.getState().config.generalModels?.map((model) => model.id)).toEqual(['removed-model', 'kept-model']);
    expect([...driver.secrets.values()]).not.toContain('pro-fixture');
  });

  it('从管理页删除指定组并持久化，其他组的连接、Key 和模型保持独立', async () => {
    addCccGroups();
    driver.native = true;
    const dialog = find(render(), (element) => 'onRemoveCccGroup' in element.props)!;
    const removed = await (dialog.props.onRemoveCccGroup as (id: string) => Promise<boolean>)('cccapi-free');
    expect(removed).toBe(true);
    expect(driver.state().config.providers['cccapi-free']).toBeUndefined();
    expect(driver.state().config.providers['cccapi-pro'].apiKey).toBe('pro-fixture');
    const fresh = configStore();
    await fresh.getState().loadConfig();
    expect(fresh.getState().config.providers).not.toHaveProperty('cccapi-free');
    expect(fresh.getState().config.providers).toHaveProperty('cccapi-pro');
    expect(fresh.getState().config.providers['cccapi-pro'].apiKey).toBe('pro-fixture');
    expect(fresh.getState().config.generalModels?.filter((model) => model.providerConfigId.startsWith('cccapi'))
      .map((model) => model.providerConfigId)).toEqual(['cccapi-pro']);
  });
});
