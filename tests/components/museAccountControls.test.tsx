/** Muse Cookie 只在组件内暂存，导入与在线验证保持独立。 */
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Cell { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
interface HookScope { cells: Cell[]; index: number; effects: Array<() => void> }
const driver = vi.hoisted(() => ({
  scope: null as HookScope | null,
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  translate: (value: string) => value,
}));
function sameDeps(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined) {
  return !!left && !!right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const scope = driver.scope!;
    const cell = scope.cells[scope.index++] ??= {};
    if (!('value' in cell)) cell.value = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [cell.value as T, (next: T | ((current: T) => T)) => {
      cell.value = typeof next === 'function' ? (next as (current: T) => T)(cell.value as T) : next;
    }];
  },
  useRef: <T,>(initial: T) => {
    const scope = driver.scope!;
    return (scope.cells[scope.index++] ??= { value: { current: initial } }).value;
  },
  useId: () => 'muse-cookie-input',
  useCallback: <T,>(callback: T, deps: readonly unknown[]) => {
    const scope = driver.scope!;
    const cell = scope.cells[scope.index++] ??= {};
    if (!sameDeps(cell.deps, deps)) { cell.value = callback; cell.deps = deps; }
    return cell.value as T;
  },
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
    const scope = driver.scope!;
    const cell = scope.cells[scope.index++] ??= {};
    if (sameDeps(cell.deps, deps)) return;
    cell.deps = deps;
    scope.effects.push(() => {
      cell.cleanup?.();
      const cleanup = effect();
      cell.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    });
  },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (command: string, args?: Record<string, unknown>) => driver.invoke(command, args) }));
vi.mock('../../src/i18n', () => ({ useT: () => driver.translate }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: () => true }));
vi.mock('../../src/services/confirmDialog', () => ({ confirmAction: vi.fn().mockResolvedValue(true) }));
vi.mock('../../src/components/settings/providerConnection/providerConnectionShared', () => ({ openExternal: vi.fn() }));

import MuseAccountControls from '../../src/components/settings/MuseAccountControls';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
let tree: unknown;
const loginChanged = vi.fn();
const credentialChanged = vi.fn();
const missing = { loggedIn: false, credentialStored: false, sessionState: 'missing', loginOpen: false, loginState: 'closed', checking: false };
const stored = { ...missing, credentialStored: true, sessionState: 'unverified' };
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).join('');
  return value && typeof value === 'object' && 'props' in value ? text((value as Element).props.children) : '';
}
function render() {
  const scope = driver.scope!;
  scope.index = 0; scope.effects = [];
  tree = MuseAccountControls({ onLoggedInChange: loginChanged, onCredentialReadyChange: credentialChanged });
  for (const effect of scope.effects) effect();
}
function button(label: string) { return elements(tree).find((element) => element.props.children === label && typeof element.props.onClick === 'function')!; }
function click(label: string) { (button(label).props.onClick as () => void)(); render(); }
function input() { return elements(tree).find((element) => element.type === 'input')!; }
function enter(value: string) { (input().props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); render(); }
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }

beforeEach(async () => {
  driver.scope = { cells: [], index: 0, effects: [] };
  driver.invoke.mockReset().mockImplementation(async (command) => command === 'muse_import_cookies' ? stored : missing);
  loginChanged.mockClear(); credentialChanged.mockClear();
  render(); await settle();
});
afterEach(() => {
  for (const cell of driver.scope!.cells) cell.cleanup?.();
  vi.unstubAllGlobals();
});

describe('Muse 手动 Cookie', () => {
  it('默认收起，导入后清空并恢复遮挡；仅凭据就绪，不谎称在线登录', async () => {
    expect(input()).toBeUndefined();
    click('手动填写 Cookie');
    expect(input().props.type).toBe('password');
    enter('hatch_sess=fixture-local-session');
    click('显示 Cookie');
    expect(input().props.type).toBe('text');
    click('保存 Cookie'); await settle();
    expect(driver.invoke).toHaveBeenCalledWith('muse_import_cookies', { cookie: 'hatch_sess=fixture-local-session' });
    expect(input().props.value).toBe('');
    expect(input().props.type).toBe('password');
    expect(credentialChanged).toHaveBeenLastCalledWith(true);
    expect(loginChanged).toHaveBeenLastCalledWith(false);
    expect(text(tree)).toContain('会话已保存，尚未验证');
    expect(driver.invoke.mock.calls.some(([command, args]) => command === 'muse_auth_status' && args?.verify === true)).toBe(false);
  });

  it('导入失败保留可修正的输入，但不展示异常原文或 Cookie', async () => {
    driver.invoke.mockImplementation(async (command) => {
      if (command === 'muse_import_cookies') throw new Error('fixture-do-not-show-cookie');
      return missing;
    });
    click('手动填写 Cookie'); enter('fixture-do-not-show-cookie');
    click('保存 Cookie'); await settle();
    expect(input().props.value).toBe('fixture-do-not-show-cookie');
    expect(text(tree)).toContain('Cookie 保存失败');
    expect(text(tree)).not.toContain('fixture-do-not-show-cookie');
    expect(credentialChanged).toHaveBeenLastCalledWith(false);
  });

  it('不等待旧状态请求，旧回包不能覆盖刚导入的凭据状态', async () => {
    let resolveOld!: (value: unknown) => void;
    driver.invoke.mockImplementation((command) => command === 'muse_auth_status'
      ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve(stored));
    click('验证 / 刷新状态'); await settle();
    click('手动填写 Cookie'); enter('fixture-manual-session');
    click('保存 Cookie'); await settle();
    expect(input().props.value).toBe('');
    expect(credentialChanged).toHaveBeenLastCalledWith(true);
    resolveOld({ ...missing, loggedIn: true, sessionState: 'verified' }); await settle();
    expect(loginChanged).toHaveBeenLastCalledWith(false);
    expect(text(tree)).toContain('会话已保存，待验证');
  });

  it('验证按钮显式开启后台检查，任务占用时禁止导入', async () => {
    driver.invoke.mockResolvedValue({ ...stored, activeTaskId: 'muse-active-task' });
    click('验证 / 刷新状态'); await settle();
    expect(driver.invoke).toHaveBeenCalledWith('muse_auth_status', { verify: true });
    click('手动填写 Cookie'); enter('fixture-manual-session');
    expect(input().props.disabled).toBe(true);
    expect(button('保存 Cookie').props.disabled).toBe(true);
    click('保存 Cookie'); await settle();
    expect(driver.invoke.mock.calls.some(([command]) => command === 'muse_import_cookies')).toBe(false);
  });

  it('等待旧状态时排队的验证不能在导入新 Cookie 后自动联网', async () => {
    let resolveOld!: (value: unknown) => void;
    driver.invoke.mockImplementation((command) => command === 'muse_auth_status'
      ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve(stored));
    click('验证 / 刷新状态'); await settle();
    click('验证 / 刷新状态');
    click('手动填写 Cookie'); enter('fixture-new-session');
    click('保存 Cookie'); await settle();
    const checksBeforeRelease = driver.invoke.mock.calls.filter(([command]) => command === 'muse_auth_status').length;
    resolveOld(missing); await settle();
    expect(driver.invoke.mock.calls.filter(([command]) => command === 'muse_auth_status')).toHaveLength(checksBeforeRelease);
    expect(credentialChanged).toHaveBeenLastCalledWith(true);
    expect(input().props.value).toBe('');
  });

  it('明确失效的会话不作为可保存凭据；登录页超时提供显式重建入口', async () => {
    driver.invoke.mockResolvedValue({ ...stored, sessionState: 'invalid', loginState: 'timeout' });
    click('验证 / 刷新状态'); await settle();
    expect(credentialChanged).toHaveBeenLastCalledWith(false);
    expect(text(tree)).toContain('Muse 会话已失效');
    click('重试登录'); await settle();
    expect(driver.invoke).toHaveBeenCalledWith('muse_login_open', { retry: true });
  });

  it.each([
    { name: '原生初始化超时', error: 'muse_webview_init_timeout', expected: 'Muse 原生浏览器初始化超时，尚未进入官网，请重试登录或手动填写 Cookie。' },
    { name: '原生初始化失败', error: new Error('muse_webview_init_failed'), expected: 'Muse 原生浏览器初始化失败，请重试登录或手动填写 Cookie。' },
    { name: '非完整错误码', error: new Error('muse_webview_init_timeout: fixture-private-cookie'), expected: 'Muse 操作未完成，请检查官网窗口或稍后重试' },
    { name: '未知原生错误', error: 'fixture-private-cookie', expected: 'Muse 操作未完成，请检查官网窗口或稍后重试' },
  ])('$name 只显示白名单文案，不回显原始异常', async ({ error, expected }) => {
    driver.invoke.mockImplementation(async (command) => {
      if (command === 'muse_login_open') throw error;
      return missing;
    });
    click('登录 Muse'); await settle();
    expect(text(tree)).toContain(expected);
    expect(text(tree)).not.toContain('fixture-private-cookie');
    expect(text(tree)).not.toContain('muse_webview_init_');
  });

  it('原生导航诊断只展示固定阶段、HRESULT 和有限整数状态', async () => {
    driver.invoke.mockResolvedValue({ ...missing, nativeNavigation: {
      stage: 'failed', failureStage: 'navigate', hresult: '0x80004005', webErrorStatus: 13, httpStatusCode: 502, isSuccess: false,
      url: 'https://untrusted.example/?hatch_sess=fixture-private-cookie', message: 'fixture-private-cookie',
    } });
    click('验证 / 刷新状态'); await settle();
    const rendered = text(tree);
    expect(rendered).toContain('原生导航失败');
    expect(rendered).toContain('发起导航');
    expect(rendered).toContain('HRESULT：0x80004005');
    expect(rendered).toContain('WebView2 状态：13');
    expect(rendered).toContain('WebView2 报告：域名无法解析');
    expect(rendered).toContain('HTTP 状态：502');
    expect(rendered).toContain('导航失败');
    expect(rendered).not.toContain('untrusted.example');
    expect(rendered).not.toContain('fixture-private-cookie');
  });

  it.each([
    { stage: 'failed', failureStage: 'fixture-private-cookie', hresult: '80004005 fixture-private-cookie', webErrorStatus: 'fixture-private-cookie', httpStatusCode: 999 },
    { stage: 'failed', hresult: '0x80004005\nfixture-private-cookie', webErrorStatus: 13.5, httpStatusCode: '502' },
    { stage: 'fixture-private-cookie', hresult: '80004005', webErrorStatus: 13, httpStatusCode: 502 },
  ])('拒绝异常原生诊断字段，不显示原始内容 %#', async (nativeNavigation) => {
    driver.invoke.mockResolvedValue({ ...missing, nativeNavigation });
    click('验证 / 刷新状态'); await settle();
    const rendered = text(tree);
    expect(rendered).not.toContain('fixture-private-cookie');
    expect(rendered).not.toContain('HRESULT');
    expect(rendered).not.toContain('WebView2 状态');
    expect(rendered).not.toContain('HTTP 状态');
  });

  it('命令失败后只读诊断缓存，并保留专门错误提示', async () => {
    driver.invoke.mockImplementation(async (command) => {
      if (command === 'muse_login_open') throw 'muse_webview_init_failed';
      return { ...missing, nativeNavigation: { stage: 'failed', failureStage: 'controller', hresult: '0x80004005' } };
    });
    click('登录 Muse'); await settle();
    expect(driver.invoke).toHaveBeenLastCalledWith('muse_auth_status', {});
    expect(text(tree)).toContain('Muse 原生浏览器初始化失败，请重试登录或手动填写 Cookie。');
    expect(text(tree)).toContain('浏览器控制器');
    expect(text(tree)).toContain('HRESULT：0x80004005');
    expect(driver.invoke.mock.calls.some(([command, args]) => command === 'muse_auth_status' && args?.verify === true)).toBe(false);
  });

  it.each([
    [14, 'WebView2 报告：操作已取消'],
    [15, 'WebView2 报告：重定向失败'],
    [16, 'WebView2 报告：意外错误'],
    [17, 'WebView2 报告：需要服务器身份验证'],
    [18, 'WebView2 报告：需要代理身份验证'],
  ])('按 SDK 枚举保留 WebView2 状态 %i 的准确含义', async (webErrorStatus, expected) => {
    driver.invoke.mockResolvedValue({ ...missing, nativeNavigation: { stage: 'failed', webErrorStatus } });
    click('验证 / 刷新状态'); await settle();
    expect(text(tree)).toContain(`WebView2 状态：${webErrorStatus}`);
    expect(text(tree)).toContain(expected);
  });

  it('未知合法枚举仅显示编号，HRESULT 必须完整且使用大写八位十六进制', async () => {
    driver.invoke.mockResolvedValue({ ...missing, nativeNavigation: { stage: 'failed', hresult: '0x8000abcd', webErrorStatus: 78 } });
    click('验证 / 刷新状态'); await settle();
    expect(text(tree)).toContain('WebView2 状态：78');
    expect(text(tree)).not.toContain('WebView2 报告');
    expect(text(tree)).not.toContain('HRESULT');
  });

  it.each([
    { startingCancel: true, localPolicy: 'deny-redirect', expected: '导航开始时已被宿主取消：是', policyLabel: '拒绝其他跳转' },
    { startingCancel: false, localPolicy: 'allow-muse', expected: '导航开始时已被宿主取消：否', policyLabel: '允许Muse' },
    { startingCancel: false, localPolicy: 'allow-login', expected: '导航开始时已被宿主取消：否', policyLabel: '允许登录跳转' },
  ])('仅显示真实布尔取消状态和固定策略 $localPolicy', async ({ startingCancel, localPolicy, expected, policyLabel }) => {
    driver.invoke.mockResolvedValue({ ...missing, nativeNavigation: { stage: 'failed', startingCancel, localPolicy } });
    click('验证 / 刷新状态'); await settle();
    expect(text(tree)).toContain(expected);
    expect(text(tree)).toContain(policyLabel);
  });

  it('被拒绝的规范 DNS 主机只显示纯文本，不构造导航链接', async () => {
    driver.invoke.mockResolvedValue({ ...missing, nativeNavigation: {
      stage: 'failed', localPolicy: 'deny-redirect', blockedHost: 'login.example.com',
    } });
    click('验证 / 刷新状态'); await settle();
    expect(text(tree)).toContain('被拒绝的目标主机：login.example.com');
    expect(elements(tree).some((element) => element.type === 'a' && String(element.props.href).includes('login.example.com'))).toBe(false);
  });

  it.each([
    'https://login.example.com/?hatch_sess=fixture-private-cookie',
    'user@login.example.com', 'login.example.com/path', 'login.example.com:443',
    'login.example.com\n', 'login..example.com', '-login.example.com', 'login.example.com.',
    `${'a'.repeat(64)}.example.com`, `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`,
    '127.0.0.1',
  ])('拒绝 URL 或非法主机诊断 %#', async (blockedHost) => {
    driver.invoke.mockResolvedValue({ ...missing, nativeNavigation: {
      stage: 'failed', localPolicy: 'deny-redirect', startingCancel: 'true', blockedHost,
    } });
    click('验证 / 刷新状态'); await settle();
    expect(text(tree)).not.toContain('被拒绝的目标主机');
    expect(text(tree)).not.toContain('导航开始时已被宿主取消');
    expect(text(tree)).not.toContain('fixture-private-cookie');
  });

  it.each([
    { downloadBlocked: true, visible: true }, { downloadBlocked: false, visible: false },
    { downloadBlocked: 'true', visible: false }, { downloadBlocked: 'fixture-private-cookie', visible: false },
  ])('只为真实布尔下载拦截记录显示固定文案 %#', async ({ downloadBlocked, visible }) => {
    driver.invoke.mockResolvedValue({ ...missing, nativeNavigation: { stage: 'failed', downloadBlocked } });
    click('验证 / 刷新状态'); await settle();
    expect(text(tree).includes('下载导航已被应用阻止')).toBe(visible);
    expect(text(tree)).not.toContain('fixture-private-cookie');
  });

  it('有已存 Cookie 但停在认证页时等待用户登录，不误报超时或已登录', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    driver.invoke.mockImplementation(async (command) => {
      if (command === 'muse_login_open') throw 'muse_webview_init_timeout';
      return { ...stored, loginOpen: true, loginState: 'waiting-login', loggedIn: false, checking: false,
        nativeNavigation: { stage: 'starting', startingCancel: false, localPolicy: 'allow-login' } };
    });
    click('登录 Muse'); await settle();
    expect(text(tree)).toContain('请在 Muse 登录窗口完成认证，返回 Muse 后会自动检查登录状态。');
    expect(text(tree)).not.toContain('初始化超时');
    expect(text(tree)).not.toContain('未能正常加载');
    expect(text(tree)).not.toContain('Muse 账号已登录');
    expect(text(tree)).toContain('允许登录跳转');
    expect(loginChanged).toHaveBeenLastCalledWith(false);
    expect(credentialChanged).toHaveBeenLastCalledWith(true);
  });
});
