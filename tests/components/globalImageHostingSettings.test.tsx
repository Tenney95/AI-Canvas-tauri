import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { AppState } from '../../src/store/useAppStore';
import type { GlobalImageHostingConfig, ImageHostingConfig, PublicImageHostingProvider } from '../../src/types/imageHosting';

const driver = vi.hoisted(() => ({
  state: {} as AppState, slots: [] as unknown[], cursor: 0,
  save: vi.fn(), persist: vi.fn(), remove: vi.fn(), update: vi.fn(), toast: vi.fn(),
}));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useId: () => 'global-hosting',
  useState: <T,>(initial: T | (() => T)) => {
    const index = driver.cursor++;
    if (!(index in driver.slots)) driver.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [driver.slots[index], (next: T | ((current: T) => T)) => {
      driver.slots[index] = typeof next === 'function' ? (next as (current: T) => T)(driver.slots[index] as T) : next;
    }];
  },
  useRef: <T,>(initial: T) => { const index = driver.cursor++; return driver.slots[index] ??= { current: initial }; },
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign(<T,>(selector: (state: AppState) => T) => selector(driver.state), { getState: () => driver.state }),
}));
vi.mock('../../src/i18n', () => ({ useT: () => (value: string) => value }));
vi.mock('../../src/components/shared/Select', () => ({ default: 'hosting-select' }));
vi.mock('../../src/components/settings/providerConnection/providerConnectionShared', () => ({ openExternal: vi.fn() }));
vi.mock('../../src/services/imageHostingService', () => ({ persistImageHosting: driver.persist, deleteImageHostingCredential: driver.remove }));

import GlobalImageHostingSettings from '../../src/components/settings/GlobalImageHostingSettings';
import { PUBLIC_IMAGE_HOSTING_TEMPLATES } from '../../src/services/imageHostingTemplates';

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
function render() { driver.cursor = 0; tree = GlobalImageHostingSettings(); }
function click(label: string) {
  const button = elements(tree).find((item) => item.type === 'button' && text(item.props.children) === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  (button.props.onClick as () => void)(); render();
}
function choose(provider: PublicImageHostingProvider) {
  const select = elements(tree).find((item) => item.type === 'hosting-select')!;
  (select.props.onChange as (value: PublicImageHostingProvider) => void)(provider); render();
}
function key(value: string) {
  const input = elements(tree).find((item) => item.type === 'input' && item.props.type === 'password')!;
  (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); render();
}
function uploadAddress(value: string) {
  const input = elements(tree).find((item) => item.type === 'input' && item.props['aria-label'] === '薄荷图床上传 API 地址')!;
  (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); render();
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }
function savedImgBB(): GlobalImageHostingConfig {
  return { provider: 'imgbb', configs: { imgbb: { enabled: true, uploadUrl: 'https://api.imgbb.com/1/upload', fileField: 'image',
    responseUrlPath: 'data.url', auth: 'form', authField: 'key',
    credentialRef: 'secret:image-host/11111111-1111-1111-1111-111111111111' } } };
}
function savedImageKit(): GlobalImageHostingConfig {
  return { provider: 'imagekit', configs: { imagekit: { ...PUBLIC_IMAGE_HOSTING_TEMPLATES.find((item) => item.id === 'imagekit')!.config,
    credentialRef: 'secret:image-host/11111111-1111-1111-1111-111111111111' } } };
}

beforeEach(() => {
  driver.slots = []; driver.cursor = 0;
  vi.clearAllMocks();
  driver.save.mockReset().mockImplementation(async () => {
    driver.state.configPersistedBaseline = structuredClone(driver.state.config);
  });
  driver.persist.mockReset().mockImplementation(async (config: ImageHostingConfig, nextKey: string) => ({ ...config,
    ...(nextKey ? { credentialRef: 'secret:image-host/22222222-2222-2222-2222-222222222222' } : {}) }));
  driver.remove.mockReset().mockResolvedValue(undefined);
  driver.update.mockImplementation((patch: Partial<AppState['config']>) => { driver.state.config = { ...driver.state.config, ...patch }; });
  driver.state = {
    config: { providers: {}, theme: 'dark' }, configHydrated: true, configPersistedBaseline: null,
    updateConfig: driver.update, saveConfig: driver.save, showToast: driver.toast,
  } as unknown as AppState;
  render();
});

describe('全局图床设置', () => {
  it('仅列出三类媒体兼容服务，国内会员服务在前，默认 Uguu，取消不保存', () => {
    expect(text(tree)).toContain('图床 · Uguu');
    click('配置');
    const select = elements(tree).find((item) => item.type === 'hosting-select')!;
    expect(select.props.value).toBe('uguu');
    expect(elements(select.props.children).filter((item) => item.type === 'option').map((item) => item.props.value))
      .toEqual(['bohe', 'uguu', 'catbox', 'imagekit', 'cloudinary']);
    expect(text(tree)).toContain('视频 64 MiB');
    choose('imagekit'); key('draft-key'); click('取消');
    expect(driver.update).not.toHaveBeenCalled();
    expect(driver.persist).not.toHaveBeenCalled();
    expect(driver.save).not.toHaveBeenCalled();
    expect(driver.remove).not.toHaveBeenCalled();
  });

  it('旧图片专用服务提示重选，保留配置与凭据，不静默切换或保存', async () => {
    const legacy = savedImgBB(); driver.state.config.imageHosting = legacy;
    render(); click('配置');
    expect(elements(tree).find((item) => item.type === 'hosting-select')!.props.value).toBe('imgbb');
    expect(text(tree)).toContain('原配置和密钥仍保留');
    expect(elements(tree).find((item) => item.type === 'button' && text(item.props.children) === '保存图床设置')!.props.disabled).toBe(true);
    click('保存图床设置'); await settle();
    expect(driver.state.config.imageHosting).toEqual(legacy);
    expect(driver.update).not.toHaveBeenCalled();
    expect(driver.persist).not.toHaveBeenCalled(); expect(driver.remove).not.toHaveBeenCalled();
  });

  it('Cloudinary 旧图片端点升级为 auto，保留 Cloud name 和预设且不改原草稿对象', async () => {
    const legacy = { ...PUBLIC_IMAGE_HOSTING_TEMPLATES.find((item) => item.id === 'cloudinary')!.config,
      uploadUrl: 'https://api.cloudinary.com/v1_1/my-cloud/image/upload', formFields: [{ name: 'upload_preset', value: 'all-media' }] };
    driver.state.config.imageHosting = { provider: 'cloudinary', configs: { cloudinary: legacy } };
    render(); click('配置');
    expect(elements(tree).filter((item) => item.type === 'input').map((item) => item.props.value)).toEqual(['my-cloud', 'all-media']);
    click('保存图床设置'); await settle();
    expect(driver.persist).toHaveBeenCalledWith(expect.objectContaining({ uploadUrl: 'https://api.cloudinary.com/v1_1/my-cloud/auto/upload',
      formFields: [{ name: 'upload_preset', value: 'all-media' }] }), '');
    expect(legacy.uploadUrl).toContain('/image/upload');
  });

  it('Catbox 可匿名上传，填写 userhash 后只保存独立凭据引用', async () => {
    click('配置'); choose('catbox'); click('保存图床设置'); await settle();
    expect(driver.state.config.imageHosting?.configs.catbox?.auth).toBe('none');
    click('配置'); key('catbox-private-hash'); click('保存图床设置'); await settle();
    expect(driver.persist).toHaveBeenLastCalledWith(expect.objectContaining({ auth: 'form', authField: 'userhash', credentialSource: 'separate' }), 'catbox-private-hash');
    expect(driver.state.config.imageHosting?.configs.catbox?.credentialRef).toBe('secret:image-host/22222222-2222-2222-2222-222222222222');
    expect(JSON.stringify(driver.update.mock.calls)).not.toContain('catbox-private-hash');
  });

  it('薄荷缺少完整 HTTPS 地址时拒绝保存，用户可配置会员后台的专用域名', async () => {
    click('配置'); choose('bohe'); key('bohe-private-token'); click('保存图床设置'); await settle();
    expect(driver.persist).not.toHaveBeenCalled();
    expect(text(tree)).toContain('请从会员后台复制完整的 HTTPS 上传 API 地址');
    expect(text(tree)).toContain('免费网页上传不代表免费 API');
    uploadAddress('http://member-upload.example/api/upload/'); click('保存图床设置'); await settle();
    expect(driver.persist).not.toHaveBeenCalled();
    uploadAddress('https://member-upload.example/api/upload/'); click('保存图床设置'); await settle();
    expect(driver.persist).toHaveBeenCalledWith(expect.objectContaining({ uploadUrl: 'https://member-upload.example/api/upload/', auth: 'form', authField: 'api_token' }), 'bohe-private-token');
    expect(driver.state.config.imageHosting?.configs.bohe?.uploadUrl).toBe('https://member-upload.example/api/upload/');
    expect(JSON.stringify(driver.update.mock.calls)).not.toContain('bohe-private-token');
  });

  it('保存独立凭据引用，保留其他服务配置，普通配置不含密钥', async () => {
    const catbox = PUBLIC_IMAGE_HOSTING_TEMPLATES.find((item) => item.id === 'catbox')!.config;
    driver.state.config.imageHosting = { provider: 'catbox', configs: { catbox } };
    render(); click('配置'); choose('imagekit'); key('private-upload-key'); click('保存图床设置'); await settle();
    const saved = driver.state.config.imageHosting!;
    expect(saved.provider).toBe('imagekit');
    expect(saved.configs.catbox).toEqual(catbox);
    expect(saved.configs.imagekit?.credentialRef).toBe('secret:image-host/22222222-2222-2222-2222-222222222222');
    expect(JSON.stringify(driver.update.mock.calls)).not.toContain('private-upload-key');
    expect(driver.persist).toHaveBeenCalledWith(expect.objectContaining({ credentialSource: 'separate', auth: 'basic' }), 'private-upload-key');
    expect(driver.save).toHaveBeenCalledWith({ silent: true, throwOnError: true });
  });

  it('保存未提交时回滚旧配置并清理新引用，不删除原凭据', async () => {
    const baseline = savedImageKit(); driver.state.config.imageHosting = baseline;
    driver.save.mockRejectedValueOnce(new Error('保存失败'));
    render(); click('配置'); key('replacement-key'); click('保存图床设置'); await settle();
    expect(driver.state.config.imageHosting).toEqual(baseline);
    expect(driver.remove).toHaveBeenCalledWith('secret:image-host/22222222-2222-2222-2222-222222222222');
    expect(driver.remove).not.toHaveBeenCalledWith(baseline.configs.imagekit!.credentialRef);
    expect(text(tree)).toContain('保存失败');
  });

  it('已提交后同步失败保留新配置和仍在使用的凭据', async () => {
    const baseline = savedImageKit(); driver.state.config.imageHosting = baseline;
    driver.state.config.providers.other = { name: '其他连接', apiKey: '', imageHosting: baseline.configs.imagekit };
    driver.save.mockImplementationOnce(async () => {
      driver.state.configPersistedBaseline = structuredClone(driver.state.config);
      throw new Error('提交后同步失败');
    });
    render(); click('配置'); key('replacement-key'); click('保存图床设置'); await settle();
    expect(driver.state.config.imageHosting!.configs.imagekit!.credentialRef).toBe('secret:image-host/22222222-2222-2222-2222-222222222222');
    expect(driver.remove).not.toHaveBeenCalled();
    expect(text(tree)).toContain('图床配置已保存，但设置同步未完成');
  });
});
