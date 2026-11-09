/**
 * providerConnectionDraftGuard — 回归测试：自定义连接未完成草稿保护。
 */
import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface HookScope { values: unknown[]; index: number }
const driver = vi.hoisted(() => ({ scope: null as HookScope | null, confirm: vi.fn() }));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const scope = driver.scope!;
    const index = scope.index++;
    if (!(index in scope.values)) scope.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [scope.values[index] as T, (next: T | ((current: T) => T)) => {
      scope.values[index] = typeof next === 'function' ? (next as (current: T) => T)(scope.values[index] as T) : next;
    }];
  },
  useRef: <T,>(value: T) => { const scope = driver.scope!; return scope.values[scope.index++] ??= { current: value }; },
  useMemo: <T,>(factory: () => T) => factory(),
  useEffect: () => {},
}));
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({ workflows: [] }) } }));
vi.mock('../../src/services/confirmDialog', () => ({ confirmAction: (...args: unknown[]) => driver.confirm(...args) }));

import ProviderConnectionDialog from '../../src/components/settings/ProviderConnectionDialog';
import ProviderConnectionForm from '../../src/components/settings/providerConnection/ProviderConnectionForm';
import ProviderModelSection from '../../src/components/settings/providerConnection/ProviderModelSection';
import ProviderImageHostingSettings from '../../src/components/settings/providerConnection/ProviderImageHostingSettings';
import { IMAGE_HOSTING_TEMPLATES } from '../../src/services/imageHostingTemplates';
import { MUSE_MODEL_MANIFEST } from '../../src/services/ai/museModels';
import type { ProviderModelSelection } from '../../src/types';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
let props: ComponentProps<typeof ProviderConnectionDialog>;
let tree: unknown;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
function render() { driver.scope!.index = 0; tree = ProviderConnectionDialog(props); }
function form() {
  return elements(tree).find((element) => element.type === ProviderConnectionForm)!.props as unknown as ComponentProps<typeof ProviderConnectionForm>;
}
function section() {
  return elements(tree).find((element) => element.type === ProviderModelSection)!.props as unknown as ComponentProps<typeof ProviderModelSection>;
}
function hosting() {
  return elements(tree).find((element) => element.type === ProviderImageHostingSettings)!.props as unknown as ComponentProps<typeof ProviderImageHostingSettings>;
}
function button(text: string) {
  return elements(tree).find((element) => element.props.children === text && typeof element.props.onClick === 'function')!;
}
function click(text: string) { (button(text).props.onClick as () => void)(); }
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }
function invalidateProtocol() {
  section().setProtocolValid(false);
  section().onProtocolDraftInvalidChange(true);
  render();
}

beforeEach(() => {
  driver.scope = { values: [], index: 0 };
  driver.confirm.mockReset().mockResolvedValue(false);
  vi.stubGlobal('document', { body: {} });
  const models: ProviderModelSelection[] = [
    { id: 'text-a', name: 'Text A', category: 'text', provider: 'custom-user', executionProfile: { preset: 'openai-chat' } },
    { id: 'text-b', name: 'Text B', category: 'text', provider: 'custom-user', executionProfile: { preset: 'openai-chat' } },
    { id: 'image-c', name: 'Image C', category: 'image', provider: 'custom-user' },
  ];
  const config = { name: '自定义测试', catalogId: 'custom-openai', apiKey: 'fixture-private-key',
    baseUrl: 'https://gateway.example/v1', selectedModels: models };
  props = { isOpen: true, connectionId: 'custom-user', initialConfig: config, initialModelId: 'text-a',
    providerConfigs: { 'custom-user': config }, connectedProviderIds: ['custom-openai'], fallbackModels: {},
    dreaminaLoggedIn: false, dreaminaLoading: false, onDreaminaLogin: vi.fn(),
    onClose: vi.fn(), onSave: vi.fn().mockResolvedValue(undefined), onSaveCccGroups: vi.fn(),
  };
  render();
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  { mode: '新增', editing: false, legacy: false, saveLabel: '添加厂商' },
  { mode: '编辑', editing: true, legacy: false, saveLabel: '保存更改' },
  { mode: '编辑旧缓存', editing: true, legacy: true, saveLabel: '保存更改' },
])('Muse $mode 连接可保存三个真实模型，不携带 Cookie 或虚构分辨率', async ({ editing, legacy, saveLabel }) => {
  driver.scope = { values: [], index: 0 };
  const models = structuredClone([...MUSE_MODEL_MANIFEST]);
  const configured = models.map((model) => legacy && model.category === 'image'
    ? { ...model, imageCapability: { ...model.imageCapability, resolutions: [] } } : model);
  const config = { name: 'Muse', catalogId: 'muse', apiKey: '', baseUrl: 'https://muse.ai', selectedModels: configured, catalogModels: configured };
  props = { ...props, connectionId: 'muse', initialConfig: editing ? config : undefined, initialModelId: undefined,
    providerConfigs: editing ? { muse: config } : {}, connectedProviderIds: editing ? ['muse'] : [], fallbackModels: { muse: models } };
  render();
  if (!editing) { section().onToggleVisibleModels(); render(); }
  expect(button(saveLabel).props.disabled).toBe(true);
  // 已保存凭据可先保存连接，在线会话验证独立进行。
  form().onMuseCredentialReadyChange?.(true);
  render();
  expect(button(saveLabel).props.disabled).toBe(false);
  click(saveLabel); await settle();
  expect(props.onSave).toHaveBeenCalledOnce();
  const [connectionId, saved] = vi.mocked(props.onSave).mock.calls[0];
  expect(connectionId).toBe('muse');
  expect(saved.selectedModels).toEqual(models);
  expect(saved.catalogModels).toEqual(models);
  const image = saved.selectedModels!.find((model) => model.id === 'muse-image')!;
  expect(image.imageCapability?.resolutions).toBeUndefined();
  expect(image.imageCapability?.defaultResolution).toBeUndefined();
  expect(image.imageCapability?.hasResolutionField).toBe(false);
  expect(saved.apiKey).toBe('');
  expect(saved).not.toHaveProperty('cookie');
  expect(saved).not.toHaveProperty('credentialStored');
});

describe('自定义连接未完成草稿保护', () => {
  it('套用内置上传格式后保存普通配置，沿用 Key 不额外保存密钥', async () => {
    const config = structuredClone(IMAGE_HOSTING_TEMPLATES.find((item) => item.id === 'toapis')!.config);
    hosting().onChange(config);
    render();
    click('保存更改');
    await settle();
    expect(props.onSave).toHaveBeenCalledOnce();
    const saved = vi.mocked(props.onSave).mock.calls[0][1].imageHosting;
    expect(saved).toEqual(config);
    expect(JSON.stringify(saved)).not.toContain('fixture-private-key');
    click('取消');
    await settle();
    expect(driver.confirm).not.toHaveBeenCalled();
  });

  it('图床配置和未保存密钥受连接草稿保护，取消不写入', async () => {
    hosting().onApiKeyChange('unsaved-image-host-secret');
    render();
    click('取消');
    await settle();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onSave).not.toHaveBeenCalled();
    expect(driver.confirm).toHaveBeenCalledOnce();
    expect(JSON.stringify(driver.confirm.mock.calls)).not.toContain('unsaved-image-host-secret');
    hosting().onApiKeyChange('');
    hosting().onChange({ enabled: true, uploadUrl: 'https://host.example/upload', fileField: 'file', responseUrlPath: 'data.url', auth: 'none' });
    render();
    driver.confirm.mockResolvedValueOnce(true);
    click('取消');
    await settle();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('有效图床配置与连接一起保存，无效地址阻止提交', async () => {
    const config = { enabled: true, uploadUrl: 'file:///private', fileField: 'file', responseUrlPath: 'data.url', auth: 'none' as const };
    hosting().onChange(config);
    render();
    click('保存更改');
    await settle();
    expect(props.onSave).not.toHaveBeenCalled();
    expect(form().catalogStatus).toBe('error');
    hosting().onChange({ ...config, uploadUrl: 'https://host.example/upload' });
    render();
    click('保存更改');
    await settle();
    expect(props.onSave).toHaveBeenCalledOnce();
    expect(vi.mocked(props.onSave).mock.calls[0][1].imageHosting).toEqual({ ...config, uploadUrl: 'https://host.example/upload' });
    click('取消');
    await settle();
    expect(driver.confirm).not.toHaveBeenCalled();
  });

  it.each([
    ['图片参数', () => section().onOpenModelSettings('image-c', 'image')],
    ['视频参数', () => section().onOpenModelSettings('text-a', 'video')],
    ['其他模型协议', () => section().onOpenModelSettings('text-b', 'protocol')],
    ['关闭协议', () => section().onCloseProtocolEditor()],
    ['取消勾选', () => section().onToggleModel('text-a')],
    ['批量取消勾选', () => section().onToggleVisibleModels()],
    ['更换分类', () => section().onUpdateModelCategory('text-a', 'video')],
  ] as const)('选择继续编辑后，%s 不会丢弃原协议或改变选择', async (_name, navigate) => {
    invalidateProtocol();
    await navigate();
    await settle();
    expect(driver.confirm).toHaveBeenCalledOnce();
    expect(section().protocolModel?.id).toBe('text-a');
    expect(section().protocolModel?.category).toBe('text');
    expect([...section().selectedIds]).toEqual(['text-a', 'text-b', 'image-c']);
    expect(section().imageCapabilityModel).toBeUndefined();
    expect(section().videoCapabilityModel).toBeUndefined();
    expect(button('保存更改').props.disabled).toBe(true);
  });

  it('明确放弃原文后才切换模型，后续正常切换不重复确认', async () => {
    invalidateProtocol();
    driver.confirm.mockResolvedValueOnce(true);
    expect(await section().onOpenModelSettings('text-b', 'protocol')).toBe(true);
    render();
    expect(section().protocolModel?.id).toBe('text-b');
    expect(await section().onOpenModelSettings('image-c', 'image')).toBe(true);
    render();
    expect(section().protocolModel).toBeUndefined();
    expect(section().imageCapabilityModel?.id).toBe('image-c');
    expect(driver.confirm).toHaveBeenCalledOnce();
  });

  it('重复点击当前协议不丢草稿，也不会弹出确认', async () => {
    invalidateProtocol();
    expect(await section().onOpenModelSettings('text-a', 'protocol')).toBe(true);
    expect(driver.confirm).not.toHaveBeenCalled();
    expect(section().protocolModel?.id).toBe('text-a');
  });

  it('仅协议结构缺项而没有未同步原文时，允许打开其他编辑器', async () => {
    section().setProtocolValid(false);
    render();
    await section().onOpenModelSettings('text-b', 'protocol');
    render();
    expect(driver.confirm).not.toHaveBeenCalled();
    expect(section().protocolModel?.id).toBe('text-b');
  });

  it('关闭未修改的连接不确认，取消未同步协议则保留弹窗', async () => {
    click('取消');
    await settle();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(driver.confirm).not.toHaveBeenCalled();
    vi.mocked(props.onClose).mockClear();
    invalidateProtocol();
    click('取消');
    await settle();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(driver.confirm).toHaveBeenCalledOnce();
    expect(section().protocolModel?.id).toBe('text-a');
  });

  it('有效配置或凭据改动后关闭会确认，恢复原值后不再确认', async () => {
    form().setApiKey('changed-fixture-key');
    render();
    click('取消');
    await settle();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(driver.confirm).toHaveBeenCalledOnce();
    expect(JSON.stringify(driver.confirm.mock.calls)).not.toContain('changed-fixture-key');
    form().setApiKey('fixture-private-key');
    render();
    form().setConnectionName('临时名称');
    render();
    click('取消');
    await settle();
    expect(driver.confirm).toHaveBeenCalledTimes(2);
    form().setConnectionName('自定义测试');
    render();
    click('取消');
    await settle();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(driver.confirm).toHaveBeenCalledTimes(2);
  });

  it('返回厂商选择前保护草稿，确认后选择新厂商建立新的未改动基线', async () => {
    props = { ...props, connectionId: undefined, initialConfig: undefined, initialModelId: undefined };
    driver.scope = { values: [], index: 0 };
    render();
    const initialCustom = elements(tree).find((element) => element.key === 'custom-openai')!;
    (initialCustom.props.onClick as () => void)();
    await settle();
    form().setConnectionName('修改后的连接');
    render();
    form().onReturnToPicker();
    await settle();
    expect(elements(tree).some((element) => element.type === ProviderConnectionForm)).toBe(true);
    driver.confirm.mockResolvedValueOnce(true);
    form().onReturnToPicker();
    await settle();
    const custom = elements(tree).find((element) => element.key === 'custom-openai')!;
    (custom.props.onClick as () => void)();
    await settle();
    driver.confirm.mockClear();
    click('取消');
    await settle();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(driver.confirm).not.toHaveBeenCalled();
  });

  it('确认等待期间不会重复弹窗，拒绝后保持原编辑器', async () => {
    let decide!: (result: boolean) => void;
    driver.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { decide = resolve; }));
    invalidateProtocol();
    const first = section().onOpenModelSettings('text-b', 'protocol');
    expect(await section().onOpenModelSettings('image-c', 'image')).toBe(false);
    expect(driver.confirm).toHaveBeenCalledOnce();
    decide(false);
    expect(await first).toBe(false);
    render();
    expect(section().protocolModel?.id).toBe('text-a');
  });

  it('保存期间不重复提交或丢弃配置，成功保存不询问放弃修改', async () => {
    let finish!: () => void;
    vi.mocked(props.onSave).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    form().setConnectionName('准备保存');
    render();
    click('保存更改');
    click('保存更改');
    render();
    expect(props.onSave).toHaveBeenCalledOnce();
    expect(button('保存中...').props.disabled).toBe(true);
    click('取消');
    await settle();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(driver.confirm).not.toHaveBeenCalled();
    finish();
    await settle();
    expect(button('保存更改').props.disabled).toBe(false);
    expect(driver.confirm).not.toHaveBeenCalled();
    click('取消');
    await settle();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(driver.confirm).not.toHaveBeenCalled();
  });

  it('新建自定义连接保存时复用试跑会话身份', async () => {
    props = { ...props, connectionId: undefined };
    driver.scope = { values: [], index: 0 };
    render();
    const scope = section().testSessionScope;
    expect(scope).toMatch(/^custom-/);
    click('添加厂商');
    await settle();
    expect(props.onSave).toHaveBeenCalledExactlyOnceWith(scope, expect.objectContaining({
      catalogId: 'custom-openai',
      selectedModels: expect.arrayContaining([expect.objectContaining({ id: 'text-a', provider: scope })]),
    }), undefined);
  });
});
