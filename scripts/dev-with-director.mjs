/**
 * npm run dev 包装：先拉起 3D 导演台，再启动 Vite 前端
 */
import { spawn } from 'node:child_process';
import { ensureDirectorDeskRunning, stopDirectorDeskIfStartedByUs } from './ensure-director-desk.mjs';

async function main() {
  try {
    await ensureDirectorDeskRunning();
  } catch (err) {
    console.warn('[director-desk] 自动启动失败，继续打开前端:', err?.message || err);
  }

  const child = spawn('vite', process.argv.slice(2), {
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
