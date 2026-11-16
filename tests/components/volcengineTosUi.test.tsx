import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps, ReactElement } from 'react';
import type { AppState } from '../../src/store/useAppStore';
import type { ApiProviderConfig } from '../../src/types';
import type { VolcengineTosCredentials } from '../../src/types/volcengineTos';

const driver = vi.hoisted(() => ({
  state: {} as AppState, slots: [] as unknown[], cursor: 0,
  captureEffects: false, effects: [] as Array<() => void | (() => void)>,
  upload: vi.fn(), directCreate: vi.fn(), pick: vi.fn(), assetUrl: vi.fn(), external: vi.fn(), openSettings: vi.fn(),
  secretRead: vi.fn(),
}));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const index = driver.cursor++;
    if (!(index in driver.slots)) driver.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [driver.slots[index], (next: T | ((current: T) => T)) => {
      driver.slots[index] = typeof next === 'function' ? (next as (current: T) => T)(driver.slots[index] as T) : next;
    }];
  },
  useRef: <T,>(initial: T) => { const index = driver.cursor++; return driver.slots[index] ??= { current: initial }; },
  useMemo: <T,>(factory: () => T) => factory(),
  useCallback: <T,>(callback: T) => callback,
  useId: () => 'tos-field',
  useEffect: (effect: () => void | (() => void)) => { if (driver.captureEffects) driver.effects.push(effect); },
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign(<T,>(selector: (state: AppState) => T) => selector(driver.state), { getState: () => driver.state }),
}));
vi.mock('../../src/i18n', () => {
  const t = (value: string, params?: Record<string, string | number>) => Object.entries(params ?? {})
    .reduce((result, [key, item]) => result.replaceAll(`{${key}}`, String(item)), value);
  return { useT: () => t, t };
});
vi.mock('@iconify/react', () => ({ Icon: 'volcengine-icon' }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: driver.pick }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: () => true, getAssetUrlFromPath: driver.assetUrl }));
vi.mock('../../src/services/providerSecretService', () => ({ readAppSecret: driver.secretRead }));
vi.mock('../../src/services/ai/providers/volcengineAssetUpload', () => ({ createVolcengineAssetViaTos: driver.upload }));
vi.mock('../../src/services/ai/providers/volcengineAssetLibrary', () => ({
  createAsset: driver.directCreate,
  listAssetGroups: async () => ({ items: [{ id: 'group-1', name: '测试素材组' }] }),
  listAssets: async () => ({ items: [{ id: 'asset-1', name: '待处理素材', status: 'Creating', groupId: 'group-1', assetType: 'Image' }] }),
  createAssetGroup: vi.fn(), deleteAsset: vi.fn(), deleteAssetGroup: vi.fn(), getAsset: vi.fn(),
  getAssetGroup: vi.fn(), updateAsset: vi.fn(), updateAssetGroup: vi.fn(),
}));
vi.mock('../../src/components/settings/providerConnection/providerConnectionShared', () => ({ openExternal: driver.external }));
vi.mock('../../src/components/shared/Select', () => ({ default: 'volcengine-select' }));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: 'volcengine-modal' }));
vi.mock('../../src/components/shared/PopupCloseButton', () => ({ default: 'volcengine-close' }));
vi.mock('../../src/components/shared/ViewportImage', () => ({ default: 'volcengine-image' }));
vi.mock('../../src/components/shared/VideoThumbnail', () => ({ default: 'volcengine-video' }));

import VolcengineAssetLibraryPanel from '../../src/components/volcengine/VolcengineAssetLibraryPanel';
import VolcengineTosSettings from '../../src/components/settings/VolcengineTosSettings';

type Element = ReactElement<Record<string, unknown>>;
let tree: unknown;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object' && 'props' in value) return text((value as Element).props.children);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function render() { driver.cursor = 0; tree = VolcengineAssetLibraryPanel({ onOpenProviderSettings: driver.openSettings }); }
function button(label: string) {
  const element = elements(tree).find((item) => item.type === 'button' && text(item.props.children) === label);
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}
function click(label: string) { (button(label).props.onClick as () => void)(); render(); }
function field(label: string, tag: string) {
  const container = elements(tree).find((item) => item.type === 'label'
    && elements(item.props.children).some((child) => child.type === 'span' && text(child.props.children) === label));
  const control = elements(container).find((item) => item.type === tag);
  if (!control) throw new Error(`Missing ${tag}: ${label}`);
  return control;
}
function choose(label: string, value: string) {
  (field(label, 'volcengine-select').props.onChange as (value: string) => void)(value); render();
}
function input(label: string, value: string) {
  (field(label, 'input').props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); render();
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }
function connection(): ApiProviderConfig {
  return {
    catalogId: 'volcengine', assetLibrary: { enabled: true, region: 'cn-beijing', projectName: 'default' },
    tosUpload: { bucket: 'test-bucket', region: 'cn-beijing', credentialRef: 'secret:provider/test/tos' },
  } as ApiProviderConfig;
}
async function mount(providers: Record<string, ApiProviderConfig> = { 'volcengine-custom': connection() }) {
  driver.state = { config: { providers }, openApiKeySettings: driver.openSettings } as unknown as AppState;
  driver.captureEffects = true; render(); driver.captureEffects = false;
  driver.effects.splice(0).forEach((effect) => { effect(); });
  await settle();
}
function uploadDialog() { click('上传素材'); choose('素材组', 'group-1'); }

beforeEach(() => {
  driver.slots = []; driver.cursor = 0; driver.effects = []; driver.captureEffects = false;
  vi.clearAllMocks();
  driver.upload.mockReset().mockResolvedValue({ id: 'asset-1' });
  driver.pick.mockReset().mockResolvedValue(null);
  driver.assetUrl.mockReset().mockImplementation(async () => 'asset://localhost/selected-media');
  driver.secretRead.mockReset().mockResolvedValue('asset-library-test-secret');
});

describe('TOS 已保存凭据的掩码与更新', () => {
  let settings: ComponentProps<typeof VolcengineTosSettings>;
  const config = { bucket: 'test-bucket', region: 'cn-beijing' as const,
    credentialRef: 'secret:provider/volcengine/tos/11111111-1111-1111-1111-111111111111' };
  function renderSettings() { driver.cursor = 0; tree = VolcengineTosSettings(settings); }
  function mountSettings(configured = true) {
    settings = { config: configured ? config : undefined, credentials: { accessKeyId: '', secretAccessKey: '' }, onChange: vi.fn(),
      onCredentialsChange: vi.fn((credentials: VolcengineTosCredentials) => { settings = { ...settings, credentials }; }) };
    renderSettings();
  }
  function credential(field: 'accessKeyId' | 'secretAccessKey') {
    return elements(tree).find((item) => item.type === 'input' && item.props.id === `tos-field-${field}`)!;
  }
  function focus(field: 'accessKeyId' | 'secretAccessKey', active: boolean) {
    (credential(field).props[active ? 'onFocus' : 'onBlur'] as () => void)(); renderSettings();
  }
  function edit(field: 'accessKeyId' | 'secretAccessKey', value: string) {
    (credential(field).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); renderSettings();
  }

  it('保存后仅显示固定密码掩码，不读取凭据、不提供查看按钮', () => {
    mountSettings();
    for (const field of ['accessKeyId', 'secretAccessKey'] as const) {
      expect(credential(field).props).toMatchObject({ type: 'password', value: '••••••••••••••••', disabled: false });
      expect(credential(field).props.placeholder).not.toContain('已保存，留空保留');
    }
    expect(elements(tree).filter((item) => item.type === 'button' && item.props['aria-pressed'] !== undefined)).toEqual([]);
    expect(elements(tree).some((item) => item.props.icon === 'mdi:eye-outline' || item.props.icon === 'mdi:eye-off-outline')).toBe(false);
    expect(driver.secretRead).not.toHaveBeenCalled();
    expect(settings.onCredentialsChange).not.toHaveBeenCalled();
  });

  it('聚焦清空占位，未修改失焦恢复掩码，不把占位写入草稿', () => {
    mountSettings();
    focus('accessKeyId', true);
    expect(credential('accessKeyId').props.value).toBe('');
    expect(credential('secretAccessKey').props.value).toBe('••••••••••••••••');
    focus('accessKeyId', false);
    expect(credential('accessKeyId').props.value).toBe('••••••••••••••••');
    expect(settings.credentials).toEqual({ accessKeyId: '', secretAccessKey: '' });
    expect(settings.onCredentialsChange).not.toHaveBeenCalled();
    expect(settings.onChange).not.toHaveBeenCalled();
    expect(driver.secretRead).not.toHaveBeenCalled();
  });

  it('更新仅提交用户重新输入的两项，清空不复制保存值或占位', () => {
    mountSettings();
    focus('accessKeyId', true); edit('accessKeyId', 'replacement-ak');
    expect(settings.onCredentialsChange).toHaveBeenLastCalledWith({ accessKeyId: 'replacement-ak', secretAccessKey: '' });
    focus('secretAccessKey', true); edit('secretAccessKey', 'replacement-sk');
    expect(settings.onCredentialsChange).toHaveBeenLastCalledWith({ accessKeyId: 'replacement-ak', secretAccessKey: 'replacement-sk' });
    edit('accessKeyId', ''); edit('secretAccessKey', '');
    expect(credential('accessKeyId').props.value).toBe('');
    expect(credential('secretAccessKey').props.value).toBe('');
    expect(settings.onCredentialsChange).toHaveBeenLastCalledWith({ accessKeyId: '', secretAccessKey: '' });
    expect(JSON.stringify(vi.mocked(settings.onCredentialsChange).mock.calls)).not.toContain('••••');
    expect(driver.secretRead).not.toHaveBeenCalled();
    driver.slots = []; mountSettings(false);
    expect(credential('accessKeyId').props).toMatchObject({ type: 'password', value: '' });
    expect(credential('secretAccessKey').props).toMatchObject({ type: 'password', value: '' });
  });
});

describe('火山人像库 TOS 上传入口', () => {
  it.each([
    ['portrait.png', 'Image'], ['motion.MOV', 'Video'], ['voice.wav', 'Audio'],
  ])('本地 %s 保留实际连接 ID，经文件引用与 TOS 入库，不直接 CreateAsset', async (fileName, assetType) => {
    await mount(); uploadDialog();
    const path = `C:\\test-media\\${fileName}`;
    driver.pick.mockResolvedValue(path);
    click('选择图片、视频或音频'); await settle();
    expect(driver.assetUrl).toHaveBeenCalledWith(path);
    expect(field('素材类型', 'volcengine-select').props.value).toBe(assetType);
    expect(text(tree)).toContain(fileName);
    expect(text(tree)).not.toContain(path);
    click('保存'); await settle();
    expect(driver.upload).toHaveBeenCalledOnce();
    expect(driver.upload).toHaveBeenCalledWith('volcengine-custom', expect.objectContaining({ signal: expect.any(AbortSignal) }), {
      assetType, groupId: 'group-1', name: fileName.replace(/\.[^.]+$/, ''), url: 'asset://localhost/selected-media',
    });
    expect(driver.directCreate).not.toHaveBeenCalled();
    expect(text(tree)).toContain('素材入库任务已提交，正在处理；状态变为可用后才能用于生成');
  });

  it('无后缀的 URL 必须选择类型，再与本地文件使用同一 TOS 入口', async () => {
    await mount(); uploadDialog(); choose('素材来源', 'url');
    input('素材名称', '远程声音'); input('素材 URL', 'https://media.example/download?id=1');
    click('保存'); await settle();
    expect(driver.upload).not.toHaveBeenCalled();
    expect(text(tree)).toContain('请选择素材类型');
    choose('素材类型', 'Audio'); click('保存'); await settle();
    expect(driver.upload).toHaveBeenCalledWith('volcengine-custom', expect.any(Object), {
      assetType: 'Audio', groupId: 'group-1', name: '远程声音', url: 'https://media.example/download?id=1',
    });
    expect(driver.directCreate).not.toHaveBeenCalled();
  });

  it('已知视频 URL 自动选择类型，标准连接沿用自己的连接 ID', async () => {
    await mount({ volcengine: connection() }); uploadDialog(); choose('素材来源', 'url');
    input('素材 URL', 'https://media.example/reference.mp4?signature=test');
    expect(field('素材类型', 'volcengine-select').props.value).toBe('Video');
    click('保存'); await settle();
    expect(driver.upload).toHaveBeenCalledWith('volcengine', expect.any(Object), expect.objectContaining({ assetType: 'Video' }));
  });

  it('未配置 TOS 时禁用文件选择和提交，并提供配置入口', async () => {
    const provider = connection(); delete provider.tosUpload;
    await mount({ 'volcengine-custom': provider }); uploadDialog();
    expect(button('选择图片、视频或音频').props.disabled).toBe(true);
    expect(button('保存').props.disabled).toBe(true);
    expect(text(tree)).toContain('请先在火山方舟连接中配置 TOS Bucket 和 AK/SK');
    click('前往配置 TOS');
    expect(driver.openSettings).toHaveBeenCalledOnce();
    expect(driver.upload).not.toHaveBeenCalled();
  });

  it('取消文件选择不生成文件引用，关闭后重新上传不保留本地草稿', async () => {
    await mount(); uploadDialog();
    click('选择图片、视频或音频'); await settle();
    expect(driver.assetUrl).not.toHaveBeenCalled();
    driver.pick.mockResolvedValue('C:\\test-media\\portrait.png');
    click('选择图片、视频或音频'); await settle();
    click('取消'); uploadDialog();
    expect(text(tree)).toContain('尚未选择文件');
    expect(text(tree)).not.toContain('portrait.png');
    click('保存'); await settle();
    expect(driver.upload).not.toHaveBeenCalled();
  });
});

describe('TOS 设置间距与访问密钥入口', () => {
  it('说明与凭据字段、下一分区之间保留间距，复用厂商控制台链接样式', () => {
    tree = VolcengineTosSettings({ config: connection().tosUpload, credentials: { accessKeyId: '', secretAccessKey: '' },
      onChange: vi.fn(), onCredentialsChange: vi.fn() });
    expect((tree as Element).props.className).toContain('mb-3');
    const hints = elements(tree).find((item) => item.type === 'div' && item.props.className === 'ui-stack ui-stack--tight mt-3');
    expect(text(hints)).toContain('AK/SK 保存后仅显示掩码，不支持再次查看');
    expect(text(hints)).toContain('生成参考素材与人像库上传共用这套 TOS 配置');
    const link = button('前往获取 AK/SK');
    expect(link.props.className).toBe('provider-external-link');
    expect(elements(link.props.children).some((item) => item.props.icon === 'mdi:open-in-new')).toBe(true);
    (link.props.onClick as () => void)();
    expect(driver.external).toHaveBeenCalledWith('https://console.volcengine.com/iam/keymanage/');
  });
});
