/**
 * 下载、校验并准备生产构建使用的 3D 导演台静态资源。
 * 运行时不会执行此脚本；最终安装包只加载已经打包的本地文件。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const RELEASE_CONFIG_PATH = join(SCRIPT_DIR, 'director-desk-release.json');
const CACHE_ROOT = join(PROJECT_ROOT, '.cache', 'director-desk');
const PUBLIC_ROOT = join(PROJECT_ROOT, 'public');
const DESTINATION_DIR = join(PUBLIC_ROOT, 'director-desk');
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const BUNDLE_MARKER = '.ai-canvas-director-desk.json';
const WINDOWS_RENAME_RETRY_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);

function renameWithRetry(source, destination) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!WINDOWS_RENAME_RETRY_ERRORS.has(error?.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
    }
  }
  throw lastError;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readReleaseConfig() {
  const value = readJson(RELEASE_CONFIG_PATH);
  const requiredStrings = ['repository', 'version', 'artifact', 'url', 'sha256', 'protocol'];
  for (const key of requiredStrings) {
    if (typeof value[key] !== 'string' || !value[key].trim()) {
      throw new Error(`[director-desk] 发布清单字段无效: ${key}`);
    }
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`[director-desk] 不支持的发布清单版本: ${String(value.schemaVersion)}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(value.sha256)) {
    throw new Error('[director-desk] 发布清单 SHA-256 格式无效');
  }
  const releaseUrl = new URL(value.url);
  if (
    releaseUrl.protocol !== 'https:'
    || releaseUrl.hostname !== 'github.com'
    || basename(releaseUrl.pathname) !== value.artifact
  ) {
    throw new Error('[director-desk] 发布清单 URL 必须指向固定的 GitHub Release 产物');
  }
  return { ...value, sha256: value.sha256.toLowerCase() };
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifyArtifact(path, release, { removeInvalid = true } = {}) {
  if (!existsSync(path)) return false;
  if (statSync(path).size > MAX_ARTIFACT_BYTES) {
    if (removeInvalid) rmSync(path, { force: true });
    return false;
  }
  const actual = sha256File(path);
  if (actual !== release.sha256) {
    const action = removeInvalid ? '丢弃' : '拒绝';
    console.warn(`[director-desk] ${action}校验失败的发布包: ${basename(path)}`);
    if (removeInvalid) rmSync(path, { force: true });
    return false;
  }
  return true;
}

async function downloadArtifact(url, destination) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'AI-Canvas-build' },
  });
  if (!response.ok) {
    throw new Error(`[director-desk] 下载失败: HTTP ${response.status}`);
  }
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_ARTIFACT_BYTES) {
    throw new Error(`[director-desk] 发布包超过 ${MAX_ARTIFACT_BYTES} 字节限制`);
  }
  if (!response.body) {
    throw new Error('[director-desk] 下载响应缺少正文');
  }
  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    receivedBytes += bytes.byteLength;
    if (receivedBytes > MAX_ARTIFACT_BYTES) {
      throw new Error(`[director-desk] 发布包超过 ${MAX_ARTIFACT_BYTES} 字节限制`);
    }
    chunks.push(bytes);
  }
  writeFileSync(destination, Buffer.concat(chunks));
}

function runTar(args, options = {}) {
  const result = spawnSync('tar', args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.error) {
    throw new Error(`[director-desk] 无法运行 tar: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`[director-desk] tar 执行失败: ${(result.stderr || '').trim()}`);
  }
  return result.stdout || '';
}

function assertSafeArchive(artifactPath) {
  const entries = runTar(['-tzf', artifactPath])
    .split(/\r?\n/)
    .map((entry) => entry.replaceAll('\\', '/').replace(/^\.\//, ''))
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error('[director-desk] 发布包为空');
  }
  for (const entry of entries) {
    const segments = entry.split('/');
    if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry) || segments.includes('..')) {
      throw new Error(`[director-desk] 发布包包含不安全路径: ${entry}`);
    }
  }
}

function validateExpandedBundle(directory, release) {
  const indexPath = join(directory, 'index.html');
  const metadataPath = join(directory, 'director-desk-release.json');
  if (!existsSync(indexPath) || !existsSync(metadataPath)) return false;
  try {
    const metadata = readJson(metadataPath);
    return metadata.name === '3d-director-desk'
      && metadata.version === release.version
      && metadata.protocol === release.protocol;
  } catch {
    return false;
  }
}

function extractArtifact(artifactPath, expandedDir, release) {
  if (validateExpandedBundle(expandedDir, release)) return;
  const stagingDir = `${expandedDir}.tmp-${process.pid}`;
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  try {
    assertSafeArchive(artifactPath);
    runTar(['-xzf', artifactPath, '-C', stagingDir]);
    if (!validateExpandedBundle(stagingDir, release)) {
      throw new Error('[director-desk] 发布包缺少匹配的入口或版本元数据');
    }
    rmSync(expandedDir, { recursive: true, force: true });
    cpSync(stagingDir, expandedDir, { recursive: true });
    if (!validateExpandedBundle(expandedDir, release)) {
      rmSync(expandedDir, { recursive: true, force: true });
      throw new Error('[director-desk] 写入构建缓存后校验失败');
    }
    rmSync(stagingDir, { recursive: true, force: true });
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function hasPreparedCurrentVersion(release) {
  if (!existsSync(join(DESTINATION_DIR, 'index.html'))) return false;
  try {
    const marker = readJson(join(DESTINATION_DIR, BUNDLE_MARKER));
    return marker.version === release.version && marker.sha256 === release.sha256;
  } catch {
    return false;
  }
}

function installExpandedBundle(expandedDir, release) {
  if (hasPreparedCurrentVersion(release)) {
    console.log(`[director-desk] 已准备 v${release.version}`);
    return;
  }

  mkdirSync(PUBLIC_ROOT, { recursive: true });
  mkdirSync(CACHE_ROOT, { recursive: true });
  const stagingDir = join(PUBLIC_ROOT, `.director-desk-staging-${process.pid}`);
  const previousDir = join(CACHE_ROOT, 'previous');
  rmSync(stagingDir, { recursive: true, force: true });
  cpSync(expandedDir, stagingDir, { recursive: true });
  writeFileSync(
    join(stagingDir, BUNDLE_MARKER),
    `${JSON.stringify({
      version: release.version,
      sha256: release.sha256,
      repository: release.repository,
      protocol: release.protocol,
    }, null, 2)}\n`,
    'utf8',
  );

  rmSync(previousDir, { recursive: true, force: true });
  let hasPreviousBundle = false;
  if (existsSync(DESTINATION_DIR)) {
    try {
      renameWithRetry(DESTINATION_DIR, previousDir);
    } catch (error) {
      if (!WINDOWS_RENAME_RETRY_ERRORS.has(error?.code)) throw error;
      cpSync(DESTINATION_DIR, previousDir, { recursive: true });
      rmSync(DESTINATION_DIR, { recursive: true, force: true });
      console.warn('[director-desk] 目录被文件监听器占用，已复制上一版本作为回滚备份');
    }
    hasPreviousBundle = true;
  }
  try {
    try {
      renameWithRetry(stagingDir, DESTINATION_DIR);
    } catch (error) {
      if (!WINDOWS_RENAME_RETRY_ERRORS.has(error?.code)) throw error;
      cpSync(stagingDir, DESTINATION_DIR, { recursive: true });
      rmSync(stagingDir, { recursive: true, force: true });
      console.warn('[director-desk] 目录被文件监听器占用，已使用校验后的复制方式安装');
    }
    if (!hasPreparedCurrentVersion(release)) {
      throw new Error('[director-desk] 安装后的静态资源校验失败');
    }
  } catch (error) {
    rmSync(DESTINATION_DIR, { recursive: true, force: true });
    if (hasPreviousBundle && existsSync(previousDir)) {
      try {
        renameWithRetry(previousDir, DESTINATION_DIR);
      } catch (restoreError) {
        if (!WINDOWS_RENAME_RETRY_ERRORS.has(restoreError?.code)) throw restoreError;
        cpSync(previousDir, DESTINATION_DIR, { recursive: true });
      }
    }
    throw error;
  }
  console.log(`[director-desk] 已准备 v${release.version}: public/director-desk`);
}

async function main() {
  const release = readReleaseConfig();
  if (hasPreparedCurrentVersion(release)) {
    console.log(`[director-desk] 已准备 v${release.version}`);
    return;
  }

  const versionCacheDir = join(CACHE_ROOT, release.version);
  const cachedArtifactPath = join(versionCacheDir, release.artifact);
  const overridePath = process.env.DIRECTOR_DESK_ARTIFACT_PATH?.trim();
  const artifactPath = overridePath ? resolve(overridePath) : cachedArtifactPath;
  mkdirSync(versionCacheDir, { recursive: true });

  if (!verifyArtifact(artifactPath, release, { removeInvalid: !overridePath })) {
    if (overridePath) {
      throw new Error(`[director-desk] 指定发布包不存在或校验失败: ${artifactPath}`);
    }
    const temporaryPath = `${cachedArtifactPath}.download-${process.pid}`;
    rmSync(temporaryPath, { force: true });
    console.log(`[director-desk] 下载 v${release.version}: ${release.url}`);
    try {
      await downloadArtifact(release.url, temporaryPath);
      if (!verifyArtifact(temporaryPath, release)) {
        throw new Error('[director-desk] 下载包 SHA-256 与发布清单不一致');
      }
      renameWithRetry(temporaryPath, cachedArtifactPath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }

  const expandedDir = join(versionCacheDir, 'expanded');
  extractArtifact(artifactPath, expandedDir, release);
  installExpandedBundle(expandedDir, release);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
