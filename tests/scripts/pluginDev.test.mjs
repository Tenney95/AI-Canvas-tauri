/**
 * pluginDev — 回归测试：plugin developer CLI。
 */
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { initPlugin, buildPlugin, checkPlugin } from '../../scripts/plugin-dev.mjs';

describe('plugin developer CLI', () => {
  // 这条集成用例会多次检查类型和打包，给 CI 冷启动留足时间。
  it('generates a portable typed plugin, bundles imports, updates hashes and rejects invalid packages without executing code', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'ai-canvas-plugin-sdk-'));
    const root = join(temporary, 'plugin');
    try {
      const manifest = await initPlugin(root);
      expect(manifest).toMatchObject({ apiVersion: 2, requiredCapabilities: ['javascript.async'] });
      await expect(initPlugin(root)).rejects.toThrow();
      const sdk = await readFile(join(root, 'host.d.ts'), 'utf8');
      expect(sdk).toContain('interface PluginUISurfaceProps');
      expect(sdk).toContain('interface ProjectContext');
      expect(sdk).toContain('interface CanvasContext');
      expect(sdk).toContain('function definePlugin');
      expect(sdk).not.toMatch(/from ['"]\.\.?\//);
      await writeFile(join(root, 'src/helper.ts'), 'export const transform = (value: string) => value.toUpperCase();', 'utf8');
      await writeFile(join(root, 'src/main.ts'), `import { transform } from './helper';
        import type { PluginUiWindowBinding } from '../host';
        const revision = (context: NonNullable<PluginUiWindowBinding['expectedContext']>): number => context.projectEpoch + context.canvasRevision;
        void revision;
        definePlugin({ tools: { uppercase: async (input) => ({ data: { output: transform(String(input.node.data.output ?? '')) } }) } });`, 'utf8');
      await buildPlugin(root);
      expect(await readFile(join(root, 'main.js'), 'utf8')).not.toContain("from './helper'");
      const before = await readFile(join(root, 'main.js'), 'utf8');
      await writeFile(join(root, 'src/main.ts'), 'definePlugin({ tools: { uppercase: () => 42 } });', 'utf8');
      await expect(buildPlugin(root)).rejects.toThrow('main.ts');
      expect(await readFile(join(root, 'main.js'), 'utf8')).toBe(before);
      // 校验器不能执行作者代码，即使入口在顶层抛出异常。
      await writeFile(join(root, 'main.js'), 'throw new Error("不得执行"); definePlugin({});', 'utf8');
      await checkPlugin(root);
      await writeFile(join(root, 'src/main.ts'), 'definePlugin({ tools: { uppercase: () => ({ data: { output: "完成" } }) } });', 'utf8');
      const raw = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
      raw.permissions.push('ui.custom', 'plugin.resources.read');
      raw.ui = { entry: 'ui.js', integrity: '0'.repeat(64), exports: { dialog: 'Panel' } };
      raw.contributes.nodeTools[0].dialog.ui = 'dialog';
      raw.resources = [{ id: 'sample', path: 'resources/sample.txt', integrity: '0'.repeat(64), bytes: 1, mediaType: 'text/plain' }];
      await mkdir(join(root, 'resources'));
      await writeFile(join(root, 'resources/sample.txt'), '示例', 'utf8');
      await writeFile(join(root, 'src/ui.ts'), 'const root = globalThis as unknown as { __AI_CANVAS_PLUGIN_HOST__: { exports: Record<string, unknown> } }; root.__AI_CANVAS_PLUGIN_HOST__.exports.Panel = () => {};', 'utf8');
      await writeFile(join(root, 'manifest.json'), JSON.stringify(raw), 'utf8');
      const built = await buildPlugin(root);
      expect(built.ui.integrity).not.toBe('0'.repeat(64));
      expect(built.resources[0].bytes).toBe(Buffer.byteLength('示例'));
      await writeFile(join(root, 'resources/sample.txt'), '被更改', 'utf8');
      await expect(checkPlugin(root)).rejects.toThrow('摘要或大小');
      await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...raw, ui: { ...raw.ui, entry: '../outside.js' } }), 'utf8');
      await expect(checkPlugin(root)).rejects.toThrow();
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }, 25000);

  it('keeps watching after startup errors and rebuilds when an unchanged manifest follows a source edit', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'ai-canvas-plugin-watch-'));
    const root = join(temporary, 'plugin');
    let child;
    let exited;
    try {
      await initPlugin(root);
      const manifest = await readFile(join(root, 'manifest.json'), 'utf8');
      await writeFile(join(root, 'manifest.json'), '{', 'utf8');
      child = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/plugin-dev.mjs', import.meta.url)), 'watch', root], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      });
      exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const waitOutput = (fragment, offset = 0) => new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          child.stdout.off('data', check);
          child.stderr.off('data', check);
          child.off('exit', stopped);
        };
        const check = () => { if (output.slice(offset).includes(fragment)) { cleanup(); resolve(); } };
        const stopped = () => { cleanup(); reject(new Error(`监听提前退出：${output}`)); };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`未收到 ${fragment}：${output}`)); }, 8000);
        child.stdout.on('data', check);
        child.stderr.on('data', check);
        child.once('exit', stopped);
        check();
      });
      await waitOutput('监听已启动');
      expect(output).not.toContain(root);
      await writeFile(join(root, 'manifest.json'), manifest, 'utf8');
      await waitOutput('构建完成');
      const before = await readFile(join(root, 'main.js'), 'utf8');
      const failureOffset = output.length;
      await writeFile(join(root, 'src/main.ts'), 'definePlugin({ tools: { uppercase: () => 42 } });', 'utf8');
      await waitOutput('main.ts', failureOffset);
      expect(await readFile(join(root, 'main.js'), 'utf8')).toBe(before);
      const offset = output.length;
      await writeFile(join(root, 'src/main.ts'), 'definePlugin({ tools: { uppercase: () => ({ data: { output: "WATCH_RECOVERED" } }) } });', 'utf8');
      // 清单内容没变，但它的文件事件仍会落在同一轮防抖里。
      await writeFile(join(root, 'manifest.json'), manifest, 'utf8');
      await waitOutput('构建完成', offset);
      expect(await readFile(join(root, 'main.js'), 'utf8')).toContain('WATCH_RECOVERED');
      child.kill('SIGINT');
      const code = await exited;
      // Windows 的 kill 不会向 Node 派发可捕获的 POSIX SIGINT，而是终止进程。
      if (process.platform === 'win32') {
        expect(code).toBeNull();
        expect(child.signalCode).toBe('SIGINT');
      } else {
        expect(code).toBe(0);
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      await rm(temporary, { recursive: true, force: true });
    }
  }, 25000);
});
