/**
 * comfyOutputs — 回归测试：findComfyOutputFile。
 */
import { describe, expect, it } from 'vitest';

import { buildComfyFileUrl, findComfyOutputFile, resolveComfyOutputUrl, sanitizeComfyOutputFile, type ComfyOutputFile, type ComfyOutputKind } from '../../src/services/comfyOutputs';

const file = (filename: string) => ({ filename, subfolder: '', type: 'output' });

describe('sanitizeComfyOutputFile', () => {
  it('只重建文件描述符，去除自定义节点的其他元数据', () => {
    const original = { ...file('result.png'), token: 'private', url: 'https://other.test/file.png', metadata: { value: true } };
    expect(sanitizeComfyOutputFile(original)).toEqual(file('result.png'));
    expect(sanitizeComfyOutputFile(original)).not.toBe(original);
    expect(original.metadata).toEqual({ value: true });
  });

  it.each([
    null, [], 'result.png', {}, { filename: '' }, { filename: '   ' }, { filename: 42 },
    { filename: 'result.png', subfolder: 42 }, { filename: 'result.png', subfolder: null },
    { filename: 'result.png', type: 'cache' }, { filename: 'result.png', type: '' },
    { filename: 'result.png', type: null }, { filename: 'result.png', type: {} },
  ])('拒绝不完整或字段类型异常的描述符 %#', (value) => {
    expect(sanitizeComfyOutputFile(value)).toBeUndefined();
  });

  it.each([
    '/tmp/result.png', '\\result.png', 'C:\\output\\result.png', 'C:result.png',
    '\\\\server\\share\\result.png', '../result.png', 'nested/../result.png',
    'nested\\..\\result.png', 'https://other.test/result.png', 'folder/', 'folder/.', 'nested/C:file.png',
    `nested/blake3:${'a'.repeat(64)}`,
  ])('拒绝绝对路径、目录和遍历文件名 %s', (filename) => {
    expect(sanitizeComfyOutputFile({ filename })).toBeUndefined();
  });

  it.each(['/tmp', 'C:\\output', '\\\\server\\share', '../outside', 'nested/../outside'])('拒绝非法子目录 %s', (subfolder) => {
    expect(sanitizeComfyOutputFile({ filename: 'result.png', subfolder })).toBeUndefined();
  });

  it.each([0, 10, 31, 127, 159])('拒绝文件名和目录中的控制字符 %s', (code) => {
    const control = String.fromCharCode(code);
    expect(sanitizeComfyOutputFile({ filename: `out${control}.png` })).toBeUndefined();
    expect(sanitizeComfyOutputFile({ filename: 'out.png', subfolder: `dir${control}` })).toBeUndefined();
  });

  it('限制每个路径字段的长度，拒绝异常描述符持久化', () => {
    expect(sanitizeComfyOutputFile({ filename: 'a'.repeat(4096) })).toEqual({ filename: 'a'.repeat(4096) });
    expect(sanitizeComfyOutputFile({ filename: 'a'.repeat(4097) })).toBeUndefined();
    expect(sanitizeComfyOutputFile({ filename: 'out.png', subfolder: 'a'.repeat(4097) })).toBeUndefined();
  });

  it('保留 Linux 合法冒号文件名和目录，不将其当成盘符或远端 URL', () => {
    expect(sanitizeComfyOutputFile({ filename: 'foo:bar.png', subfolder: 'scene:01' }))
      .toEqual({ filename: 'foo:bar.png', subfolder: 'scene:01' });
    expect(buildComfyFileUrl('http://comfy.test', { filename: 'foo:bar.png' }))
      .toBe('http://comfy.test/view?filename=foo%3Abar.png&type=output');
  });

  it.each(['nested/deep/result.png', 'nested\\deep\\result.png'])('拆出相对文件名里的目录 %s', (filename) => {
    expect(sanitizeComfyOutputFile({ filename })).toEqual({ filename: 'result.png', subfolder: 'nested/deep' });
    expect(sanitizeComfyOutputFile({ filename, subfolder: '' })).toEqual({ filename: 'result.png', subfolder: 'nested/deep' });
  });

  it('显式目录优先，不重复叠加文件名自带目录', () => {
    expect(sanitizeComfyOutputFile({ filename: 'nested/result.png', subfolder: 'nested' }))
      .toEqual({ filename: 'result.png', subfolder: 'nested' });
    expect(sanitizeComfyOutputFile({ filename: 'ignored/result.png', subfolder: 'actual\\deep' }))
      .toEqual({ filename: 'result.png', subfolder: 'actual/deep' });
  });

  it.each(['input', 'output', 'temp'])('兼容官方目录注解 %s，其优先级高于独立 type', (type) => {
    const descriptor = { filename: 'result.png', subfolder: 'nested', type };
    expect(sanitizeComfyOutputFile({ filename: `nested/result.png [${type}]`, type: 'output' })).toEqual(descriptor);
    expect(sanitizeComfyOutputFile(descriptor)).toEqual(descriptor);
    expect(sanitizeComfyOutputFile({ filename: `result.png [output] [${type}]` })).toBeUndefined();
  });

  it('大小写和尾空白沿用后端取件语义，保留其字面文件名', () => {
    expect(sanitizeComfyOutputFile({ filename: 'file.png [TEMP]', type: 'output' }))
      .toEqual({ filename: 'file.png [TEMP]', type: 'output' });
    expect(sanitizeComfyOutputFile({ filename: 'file.png [temp] ', type: 'output' }))
      .toEqual({ filename: 'file.png [temp] ', type: 'output' });
    expect(sanitizeComfyOutputFile({ filename: 'file.png  [temp]', type: 'output' }))
      .toEqual({ filename: 'file.png ', type: 'temp' });
    // stock 后端只匹配后缀，再固定截断，并不验证注解前是否有空格。
    expect(sanitizeComfyOutputFile({ filename: 'file[output]' }))
      .toEqual({ filename: 'fil', type: 'output' });
    expect(sanitizeComfyOutputFile({ filename: 'file😀[output]' }))
      .toEqual({ filename: 'file', type: 'output' });
  });

  it('保留官方 blake3 资源标识，拒绝伪装为 hash 的路径或 URL', () => {
    const hash = `blake3:${'a'.repeat(64)}`;
    expect(sanitizeComfyOutputFile({ filename: hash, metadata: 'discard' })).toEqual({ filename: hash });
    expect(sanitizeComfyOutputFile({ filename: `blake3:${'a'.repeat(63)}` })).toBeUndefined();
    expect(sanitizeComfyOutputFile({ filename: `blake3:${'a'.repeat(64)}/result.png` })).toBeUndefined();
    expect(sanitizeComfyOutputFile({ filename: `${hash} [temp]` })).toBeUndefined();
  });
});

describe('findComfyOutputFile', () => {
  it('finds audio under the built-in singular "audio" key', () => {
    // ComfyUI 内置 SaveAudio / PreviewAudio 用的就是这个键名
    expect(findComfyOutputFile({ '9': { audio: [file('voice.flac')] } }, ['audio']))
      .toEqual(file('voice.flac'));
  });

  it('still finds audio under the plural "audios" key', () => {
    expect(findComfyOutputFile({ '9': { audios: [file('voice.mp3')] } }, ['audio']))
      .toEqual(file('voice.mp3'));
  });

  it('falls back to the file extension when the key name is unknown', () => {
    expect(findComfyOutputFile({ '9': { result: [file('voice.wav')] } }, ['audio']))
      .toEqual(file('voice.wav'));
  });

  it('does not mistake an image output for audio', () => {
    expect(findComfyOutputFile({ '9': { images: [file('preview.png')] } }, ['audio'])).toBeNull();
  });

  it('finds a video stored under images by extension without accepting a preview png', () => {
    expect(findComfyOutputFile({ '9': { images: [file('result.mp4')] } }, ['video']))
      .toEqual(file('result.mp4'));
    expect(findComfyOutputFile({ '9': { images: [file('preview.png')] } }, ['video']))
      .toBeNull();
  });

  it.each(['videos', 'video', 'gifs'])('does not trust the %s key to identify video content', (key) => {
    const previews = [file('preview.png'), file('preview.webp'), file('preview.gif')];
    expect(findComfyOutputFile({ '8': { [key]: previews } }, ['video'])).toBeNull();
    expect(findComfyOutputFile({ '8': { [key]: [...previews, file('result.MP4')] } }, ['video']))
      .toEqual(file('result.MP4'));
  });

  it('prefers the saved video over an earlier temporary video preview', () => {
    const preview = { ...file('preview.webm'), type: 'temp' };
    const saved = { ...file('final.mp4'), subfolder: 'video' };
    expect(findComfyOutputFile({ '1': { videos: [preview] }, '9': { gifs: [saved] } }, ['video']))
      .toEqual(saved);
    expect(findComfyOutputFile({ '1': { gifs: [preview, saved] } }, ['video'])).toEqual(saved);
    expect(findComfyOutputFile({ '1': { videos: [preview] } }, ['video'])).toEqual(preview);
  });

  it('honours the kind priority across nodes', () => {
    const outputs = {
      '8': { images: [file('frame.png')] },
      '9': { audio: [file('voice.flac')] },
    };
    expect(findComfyOutputFile(outputs, ['audio', 'image'])).toEqual(file('voice.flac'));
    expect(findComfyOutputFile(outputs, ['image', 'audio'])).toEqual(file('frame.png'));
  });

  it.each([
    ['image', 'images', 'png'], ['audio', 'audio', 'flac'], ['video', 'videos', 'mp4'],
  ] as const)('%s 先取正式输出，再兼容未声明类型及仅预览的旧工作流', (kind, key, extension) => {
    const preview = { ...file(`preview.${extension}`), type: 'temp' };
    const legacy = { filename: `legacy.${extension}` };
    const saved = file(`saved.${extension}`);
    expect(findComfyOutputFile({ '1': { [key]: [preview] }, '2': { [key]: [legacy] }, '9': { [key]: [saved] } }, [kind]))
      .toEqual(saved);
    expect(findComfyOutputFile({ '1': { [key]: [preview, legacy, saved] } }, [kind])).toEqual(saved);
    expect(findComfyOutputFile({ '1': { [key]: [preview] }, '2': { [key]: [legacy] } }, [kind])).toEqual(legacy);
    expect(findComfyOutputFile({ '1': { [key]: [preview] } }, [kind])).toEqual(preview);
  });

  it('保留媒体类型优先级，不因另一类存在正式输出而改投', () => {
    const preview = { ...file('preview.png'), type: 'temp' };
    const audio = file('saved.flac');
    const kinds: ComfyOutputKind[] = ['image', 'audio'];
    expect(findComfyOutputFile({ '1': { images: [preview] }, '9': { audio: [audio] } }, kinds)).toEqual(preview);
  });

  it('ignores entries without a filename', () => {
    expect(findComfyOutputFile({ '9': { audio: [{ subfolder: '' } as ComfyOutputFile] } }, ['audio'])).toBeNull();
  });

  it.each([
    ['image', 'images', 'result.mp4'], ['image', 'images', 'voice.wav'],
    ['audio', 'audio', 'preview.png'], ['audio', 'audios', 'result.mp4'],
  ] as const)('不因已知键名把 %s 的 %s 中 %s 认成另一种媒体', (kind, key, filename) => {
    expect(findComfyOutputFile({ '9': { [key]: [file(filename)] } }, [kind])).toBeNull();
  });

  it.each([
    ['image', 'images', 'no-extension'], ['image', 'image', 'advanced.exr'],
    ['image', 'images', 'advanced.avif'], ['image', 'images', 'custom.format'],
    ['image', 'images', `blake3:${'a'.repeat(64)}`], ['audio', 'audio', 'no-extension'],
  ] as const)('已知 %s 键 %s 保留兼容描述符 %s', (kind, key, filename) => {
    expect(findComfyOutputFile({ '9': { [key]: [file(filename)] } }, [kind])).toEqual(file(filename));
  });

  it('陌生键仍需明确媒体扩展名，不把文本或任意对象当图片', () => {
    expect(findComfyOutputFile({ '9': { text: ['plain text'], result: [file('unknown.format')] } }, ['image'])).toBeNull();
    expect(findComfyOutputFile({ '9': { result: [file('image.avif')] } }, ['image'])).toEqual(file('image.avif'));
  });

  it('跳过无效描述符，保持正式输出与临时输出的选择优先级', () => {
    expect(findComfyOutputFile({
      '1': { images: [{ filename: '', type: 'output' }, file('../invalid.png')] },
      '2': { images: [{ filename: 'nested/preview.png', type: 'temp' }] },
      '9': { images: [file('final.png')] },
    }, ['image'])).toEqual(file('final.png'));
    expect(findComfyOutputFile({ '2': { images: [{ filename: 'nested/preview.png', type: 'temp' }] } }, ['image']))
      .toEqual({ filename: 'preview.png', subfolder: 'nested', type: 'temp' });
  });
});

describe('resolveComfyOutputUrl', () => {
  it('builds a /view url for the matched file', () => {
    expect(
      resolveComfyOutputUrl(
        'http://comfy.test:8188',
        { '9': { audio: [{ filename: 'voice.flac', subfolder: 'audio', type: 'output' }] } },
        ['audio'],
      ),
    ).toEqual({
      url: 'http://comfy.test:8188/view?filename=voice.flac&subfolder=audio&type=output',
      file: { filename: 'voice.flac', subfolder: 'audio', type: 'output' },
    });
  });

  it('保留反向代理基础路径，去掉尾部斜杠并返回可保存的白名单描述符', () => {
    const output = { filename: 'nested/第 1 帧.png [temp]', metadata: 'discard' };
    expect(resolveComfyOutputUrl('https://proxy.test/comfy///', {
      '9': { images: [output] },
    }, ['image'])).toEqual({
      url: 'https://proxy.test/comfy/view?filename=%E7%AC%AC%201%20%E5%B8%A7.png&subfolder=nested&type=temp',
      file: { filename: '第 1 帧.png', subfolder: 'nested', type: 'temp' },
    });
  });

  it('直接拼接取件地址也拒绝无效描述符', () => {
    expect(() => buildComfyFileUrl('https://comfy.test', { filename: '../outside.png' }))
      .toThrow('ComfyUI 输出文件描述无效');
  });

  it('returns null when nothing matched', () => {
    expect(resolveComfyOutputUrl('http://comfy.test:8188', {}, ['audio'])).toBeNull();
  });
});
