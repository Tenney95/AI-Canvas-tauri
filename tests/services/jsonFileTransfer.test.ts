import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({ native: true, save: vi.fn(), write: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: driver.save }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: driver.write }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: () => driver.native }));

import { exportJsonTextFile, readJsonTextFile, MAX_JSON_FILE_BYTES } from '../../src/services/fs/jsonFileTransfer';

beforeEach(() => {
  driver.native = true;
  driver.save.mockReset().mockResolvedValue('selected/connection.json');
  driver.write.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('JSON 文件传输', () => {
  it('桌面另存为使用 JSON 过滤器并写入 UTF-8 中文，文件名不包含路径分隔符', async () => {
    const text = JSON.stringify({ name: '自定义接口', models: ['图片', '视频'] });
    expect(await exportJsonTextFile(text, '测试/接口\\配置.JSON')).toBe(true);
    expect(driver.save).toHaveBeenCalledWith({ defaultPath: '测试_接口_配置.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    expect(driver.write).toHaveBeenCalledWith('selected/connection.json', new TextEncoder().encode(text));
  });

  it('取消另存为不写文件，写入失败不会被报告为导出成功', async () => {
    driver.save.mockResolvedValueOnce(null);
    expect(await exportJsonTextFile('{}', 'connection')).toBe(false);
    expect(driver.write).not.toHaveBeenCalled();
    driver.write.mockRejectedValueOnce(new Error('write failed'));
    await expect(exportJsonTextFile('{}', 'connection')).rejects.toThrow('write failed');
  });

  it('浏览器下载 JSON 文件并释放临时 URL', async () => {
    driver.native = false;
    vi.useFakeTimers();
    const link = { href: '', download: '', hidden: false, click: vi.fn(), remove: vi.fn() };
    const appendChild = vi.fn();
    vi.stubGlobal('document', { createElement: vi.fn(() => link), body: { appendChild } });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:json-fixture');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    expect(await exportJsonTextFile('{"name":"自定义"}', '连接')).toBe(true);
    const blob = create.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/json;charset=utf-8');
    expect(await blob.text()).toBe('{"name":"自定义"}');
    expect(link).toMatchObject({ href: 'blob:json-fixture', download: '连接.json', hidden: true });
    expect(appendChild).toHaveBeenCalledWith(link);
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:json-fixture');
    expect(driver.save).not.toHaveBeenCalled();
  });

  it('接收 UTF-8 中文和 BOM，拒绝非法编码', async () => {
    expect(await readJsonTextFile(new File(['\uFEFF{"name":"模型"}'], 'config.json'))).toBe('{"name":"模型"}');
    await expect(readJsonTextFile(new File([new Uint8Array([0xff])], 'config.json'))).rejects.toMatchObject({ code: 'invalid-utf8' });
  });

  it('超过体积限制时读取前拒绝，并复核实际字节长度', async () => {
    const arrayBuffer = vi.fn();
    await expect(readJsonTextFile({ size: MAX_JSON_FILE_BYTES + 1, arrayBuffer } as unknown as File))
      .rejects.toMatchObject({ code: 'too-large' });
    expect(arrayBuffer).not.toHaveBeenCalled();
    arrayBuffer.mockResolvedValue(new ArrayBuffer(MAX_JSON_FILE_BYTES + 1));
    await expect(readJsonTextFile({ size: 1, arrayBuffer } as unknown as File)).rejects.toMatchObject({ code: 'too-large' });
  });
});
