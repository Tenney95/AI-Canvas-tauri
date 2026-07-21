/**
 * npm run tauri 的包装：
 * - `npm run tauri dev` 会先自动拉起 3D 导演台，再启动无限画布
 * - `npm run tauri build` 等其它子命令不启动导演台
 */
import { spawn } from 'node:child_process';
import { ensureDirectorDeskRunning, stopDirectorDeskIfStartedByUs } from './ensure-director-desk.mjs';

const args = process.argv.slice(2);
const isDev = args[0] === 'dev';

async function main() {
  if (isDev) {
    try {
      await ensureDirectorDeskRunning();
    } catch (err) {
      console.warn('[director-desk] 自动启动失败，继续打开画布:', err?.message || err);
    }
  }

  const child = spawn('tauri', args, {
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });

  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  };

  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  child.on('exit', (code, signal) => {
    stopDirectorDeskIfStartedByUs();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
