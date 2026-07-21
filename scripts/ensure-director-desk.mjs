/**
 * 确保本地 3D 导演台（Tenney95/3d-director-desk）在独立端口运行。
 * 单独运行: node scripts/ensure-director-desk.mjs
 * 也可: npm run director
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const DIRECTOR_ORIGIN = process.env.DIRECTOR_DESK_ORIGIN || 'http://127.0.0.1:5178';
export const DIRECTOR_DIR =
  process.env.DIRECTOR_DESK_DIR || resolve(homedir(), 'Projects', '3d-director-desk');
export const DIRECTOR_REPO_URL =
  process.env.DIRECTOR_DESK_REPO_URL || 'https://github.com/Tenney95/3d-director-desk.git';

const PID_FILE = join(homedir(), '.cache', 'ai-canvas-director-desk.pid');
const DIRECTOR_TITLE_PATTERN = /<title>\s*3D导演台 Demo\s*<\/title>/i;

async function probeDirector(origin = DIRECTOR_ORIGIN, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(origin, { signal: controller.signal });
    if (!res.ok && res.status !== 304) return 'down';
    const html = await res.text();
    return DIRECTOR_TITLE_PATTERN.test(html) ? 'director' : 'occupied';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

function runCommand(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: true,
      env: process.env,
      ...options,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} 失败: ${code}`));
    });
  });
}

async function ensureDirectorDeskInstalled() {
  if (!existsSync(DIRECTOR_DIR)) {
    console.log(`[director-desk] 首次安装，正在克隆: ${DIRECTOR_REPO_URL}`);
    mkdirSync(dirname(DIRECTOR_DIR), { recursive: true });
    await runCommand('git', ['clone', '--depth', '1', DIRECTOR_REPO_URL, DIRECTOR_DIR]);
  }

  if (!existsSync(join(DIRECTOR_DIR, 'package.json'))) {
    throw new Error(`[director-desk] 目录不是有效项目: ${DIRECTOR_DIR}`);
  }

  if (!existsSync(join(DIRECTOR_DIR, 'node_modules'))) {
    console.log('[director-desk] 首次安装依赖…');
    await runCommand('npm', ['install'], { cwd: DIRECTOR_DIR });
  }
}

function getDirectorDevServerArgs() {
  const url = new URL(DIRECTOR_ORIGIN);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`[director-desk] 不支持的地址协议: ${DIRECTOR_ORIGIN}`);
  }
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(`[director-desk] 远程地址不可用，无法自动启动: ${DIRECTOR_ORIGIN}`);
  }
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return ['run', 'dev', '--', '--host', url.hostname, '--port', port, '--strictPort'];
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
  const initialProbe = await probeDirector();
  if (initialProbe === 'director') {
    console.log(`[director-desk] 已在运行: ${DIRECTOR_ORIGIN}`);
    return { started: false, origin: DIRECTOR_ORIGIN };
  }
  if (initialProbe === 'occupied') {
    throw new Error(
      `[director-desk] ${DIRECTOR_ORIGIN} 已被其它网页占用，请修改 DIRECTOR_DESK_ORIGIN`,
    );
  }

  await ensureDirectorDeskInstalled();

  console.log(`[director-desk] 启动中 → ${DIRECTOR_ORIGIN}`);
  console.log(`[director-desk] 目录: ${DIRECTOR_DIR}`);

  const child = spawn(
    'npm',
    getDirectorDevServerArgs(),
    {
      cwd: DIRECTOR_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      env: process.env,
      detached: true,
    },
  );

  let exitError = null;
  child.once('error', (error) => {
    exitError = error;
  });
  child.once('exit', (code) => {
    if (code !== 0) exitError = new Error(`导演台进程退出: ${code}`);
  });

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
    if (exitError) throw exitError;
    const probe = await probeDirector();
    if (probe === 'director') {
      console.log(`[director-desk] 就绪: ${DIRECTOR_ORIGIN}`);
      return { started: true, origin: DIRECTOR_ORIGIN };
    }
    if (probe === 'occupied') {
      throw new Error(`[director-desk] ${DIRECTOR_ORIGIN} 被非导演台页面占用`);
    }
  }

  throw new Error(
    `[director-desk] 启动超时，请检查 ${DIRECTOR_ORIGIN} 或运行 npm run director`,
  );
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
