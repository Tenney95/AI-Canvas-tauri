/**
 * 确保本地 3D 导演台（xiaozangao/3d-director-desk）在 5173 运行。
 * 单独运行: node scripts/ensure-director-desk.mjs
 * 也可: npm run director
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const DIRECTOR_ORIGIN = process.env.DIRECTOR_DESK_ORIGIN || 'http://127.0.0.1:5173';
export const DIRECTOR_DIR =
  process.env.DIRECTOR_DESK_DIR || resolve(homedir(), 'Projects', '3d-director-desk');

const PID_FILE = join(homedir(), '.cache', 'ai-canvas-director-desk.pid');

async function isDirectorUp(origin = DIRECTOR_ORIGIN, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(origin, { signal: controller.signal });
    return res.ok || res.status === 200 || res.status === 304;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function savePid(pid) {
  try {
    mkdirSync(join(homedir(), '.cache'), { recursive: true });
    writeFileSync(PID_FILE, String(pid), 'utf8');
  } catch {
    /* ignore */
  }
}

function readSavedPid() {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{ started: boolean, origin: string }>}
 */
export async function ensureDirectorDeskRunning() {
  if (await isDirectorUp()) {
    console.log(`[director-desk] 已在运行: ${DIRECTOR_ORIGIN}`);
    return { started: false, origin: DIRECTOR_ORIGIN };
  }

  if (!existsSync(DIRECTOR_DIR)) {
    console.warn(
      `[director-desk] 未找到目录: ${DIRECTOR_DIR}\n` +
        `  请先: git clone https://github.com/xiaozangao/3d-director-desk.git "${DIRECTOR_DIR}"\n` +
        `  或设置环境变量 DIRECTOR_DESK_DIR`,
    );
    return { started: false, origin: DIRECTOR_ORIGIN };
  }

  if (!existsSync(join(DIRECTOR_DIR, 'node_modules'))) {
    console.log('[director-desk] 首次安装依赖…');
    await new Promise((resolvePromise, reject) => {
      const install = spawn('npm', ['install'], {
        cwd: DIRECTOR_DIR,
        stdio: 'inherit',
        shell: true,
        env: process.env,
      });
      install.on('exit', (code) =>
        code === 0 ? resolvePromise() : reject(new Error(`npm install 失败: ${code}`)),
      );
    });
  }

  console.log(`[director-desk] 启动中 → ${DIRECTOR_ORIGIN}`);
  console.log(`[director-desk] 目录: ${DIRECTOR_DIR}`);

  const child = spawn(
    'npm',
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173'],
    {
      cwd: DIRECTOR_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      env: process.env,
      detached: true,
    },
  );

  child.unref();
  if (child.pid) savePid(child.pid);

  child.stdout?.on('data', (buf) => {
    const text = buf.toString();
    if (/Local:|ready in|error/i.test(text)) {
      process.stdout.write(`[director-desk] ${text}`);
    }
  });
  child.stderr?.on('data', (buf) => {
    const text = buf.toString();
    if (/error|ERR|EADDRINUSE/i.test(text)) {
      process.stderr.write(`[director-desk] ${text}`);
    }
  });

  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await isDirectorUp()) {
      console.log(`[director-desk] 就绪: ${DIRECTOR_ORIGIN}`);
      return { started: true, origin: DIRECTOR_ORIGIN };
    }
  }

  console.warn(
    `[director-desk] 启动超时，画布仍会继续打开；请检查 ${DIRECTOR_ORIGIN}\n` +
      `  或手动: npm run director`,
  );
  return { started: true, origin: DIRECTOR_ORIGIN };
}

export function stopDirectorDeskIfStartedByUs() {
  if (process.env.DIRECTOR_DESK_KILL_ON_EXIT !== '1') return;
  const pid = readSavedPid();
  if (!pid || !isProcessAlive(pid)) {
    try {
      unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
  }
  try {
    unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] && resolve(process.argv[1]) === thisFile;

if (invoked) {
  ensureDirectorDeskRunning()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
