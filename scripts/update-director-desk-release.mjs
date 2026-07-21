import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createGunzip, gunzipSync } from 'node:zlib';

const REPOSITORY = 'Tenney95/3d-director-desk';
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 300 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const TAR_BLOCK_BYTES = 512;
const MAX_TAR_STREAM_BYTES = MAX_EXPANDED_BYTES + (MAX_ARCHIVE_ENTRIES * TAR_BLOCK_BYTES);
const MAX_METADATA_BYTES = 64 * 1024;
const RELEASE_METADATA_FILE = 'director-desk-release.json';
const MANIFEST_PATH = fileURLToPath(new URL('./director-desk-release.json', import.meta.url));

export function normalizeReleaseTag(input) {
  const tag = String(input ?? '').trim();
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(tag)) {
    throw new Error('导演台版本必须是明确的 vX.Y.Z tag，例如 v0.3.2');
  }
  return { tag, version: tag.slice(1) };
}

export function parseChecksumFile(text, artifact) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match?.[2] === artifact) return match[1].toLowerCase();
  }
  throw new Error(`SHA-256 文件未包含目标产物 ${artifact}`);
}

function readTarText(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  const boundedEnd = end >= offset && end < offset + length ? end : offset + length;
  return buffer.toString('utf8', offset, boundedEnd).trim();
}

function readTarOctal(buffer, offset, length, fieldName) {
  if ((buffer[offset] & 0x80) !== 0) {
    throw new Error(`导演台压缩包使用了不支持的 ${fieldName} 编码`);
  }
  const text = readTarText(buffer, offset, length).replaceAll('\0', '').trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`导演台压缩包的 ${fieldName} 字段无效`);
  }
  return Number.parseInt(text, 8);
}

function assertTarHeaderChecksum(header) {
  const expected = readTarOctal(header, 148, 8, '校验和');
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) {
    throw new Error('导演台压缩包的 tar 头校验失败');
  }
}

function normalizeArchivePath(name) {
  if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`导演台压缩包包含不安全路径: ${name || '<empty>'}`);
  }
  const segments = name.split('/').filter((segment) => segment && segment !== '.');
  if (segments.includes('..')) {
    throw new Error(`导演台压缩包包含不安全路径: ${name}`);
  }
  return segments.join('/');
}

class TarInspector {
  constructor(expected) {
    this.expected = expected;
    this.buffer = Buffer.alloc(0);
    this.currentEntry = null;
    this.expandedBytes = 0;
    this.entryCount = 0;
    this.hasIndex = false;
    this.releaseMetadata = null;
    this.pendingLongPath = null;
    this.streamBytes = 0;
    this.ended = false;
  }

  write(chunk) {
    if (this.ended) return;
    this.streamBytes += chunk.length;
    if (this.streamBytes > MAX_TAR_STREAM_BYTES) {
      throw new Error('导演台压缩包展开数据超过限制');
    }
    this.buffer = this.buffer.length > 0
      ? Buffer.concat([this.buffer, chunk])
      : Buffer.from(chunk);

    while (!this.ended) {
      if (!this.currentEntry) {
        if (this.buffer.length < TAR_BLOCK_BYTES) return;
        const header = this.buffer.subarray(0, TAR_BLOCK_BYTES);
        this.buffer = this.buffer.subarray(TAR_BLOCK_BYTES);
        if (header.every((byte) => byte === 0)) {
          this.ended = true;
          return;
        }
        this.currentEntry = this.readHeader(header);
        if (this.currentEntry.paddedBytes === 0) {
          this.completeEntry();
          continue;
        }
      }

      if (this.buffer.length === 0) return;
      const consumed = Math.min(this.buffer.length, this.currentEntry.paddedBytes);
      if (this.currentEntry.metadataBytesRemaining > 0) {
        const metadataBytes = Math.min(consumed, this.currentEntry.metadataBytesRemaining);
        this.currentEntry.metadataChunks.push(this.buffer.subarray(0, metadataBytes));
        this.currentEntry.metadataBytesRemaining -= metadataBytes;
      }
      this.currentEntry.paddedBytes -= consumed;
      this.buffer = this.buffer.subarray(consumed);
      if (this.currentEntry.paddedBytes === 0) this.completeEntry();
    }
  }

  readHeader(header) {
    assertTarHeaderChecksum(header);
    const name = readTarText(header, 0, 100);
    const prefix = readTarText(header, 345, 155);
    const size = readTarOctal(header, 124, 12, '文件大小');
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const headerPath = normalizeArchivePath(prefix ? `${prefix}/${name}` : name);
    const archivePath = this.pendingLongPath && (type === '0' || type === '5')
      ? this.pendingLongPath
      : headerPath;
    if (type === '0' || type === '5') this.pendingLongPath = null;

    if (type !== '0' && type !== '5' && type !== 'L') {
      throw new Error(`导演台压缩包包含不允许的特殊条目: ${archivePath}`);
    }
    if (type === '0' || type === '5') {
      this.entryCount += 1;
      if (this.entryCount > MAX_ARCHIVE_ENTRIES) {
        throw new Error(`导演台压缩包文件数超过限制 ${MAX_ARCHIVE_ENTRIES}`);
      }
    }
    if (type === '0') {
      this.expandedBytes += size;
      if (this.expandedBytes > MAX_EXPANDED_BYTES) {
        throw new Error('导演台压缩包展开大小超过 300 MB 限制');
      }
      if (archivePath === 'index.html') this.hasIndex = true;
    }
    const capturesMetadata = type === '0' && archivePath === RELEASE_METADATA_FILE;
    const capturesLongPath = type === 'L';
    if ((capturesMetadata || capturesLongPath) && size > MAX_METADATA_BYTES) {
      throw new Error('导演台压缩包元数据超过 64 KB 限制');
    }
    return {
      archivePath,
      capturesMetadata,
      capturesLongPath,
      metadataBytesRemaining: capturesMetadata || capturesLongPath ? size : 0,
      metadataChunks: [],
      paddedBytes: Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES,
    };
  }

  completeEntry() {
    const captured = Buffer.concat(this.currentEntry.metadataChunks);
    if (this.currentEntry.capturesLongPath) {
      const end = captured.indexOf(0);
      const rawPath = captured.toString('utf8', 0, end >= 0 ? end : captured.length);
      this.pendingLongPath = normalizeArchivePath(rawPath);
    } else if (this.currentEntry.capturesMetadata) {
      try {
        this.releaseMetadata = JSON.parse(captured.toString('utf8'));
      } catch (error) {
        throw new Error(`导演台发布元数据不是有效 JSON: ${error.message}`);
      }
    }
    this.currentEntry = null;
  }

  finish() {
    if (!this.ended || this.currentEntry || this.pendingLongPath) {
      throw new Error('导演台压缩包内容不完整');
    }
    if (!this.hasIndex) throw new Error('导演台压缩包缺少 index.html');
    if (
      this.releaseMetadata?.name !== '3d-director-desk'
      || this.releaseMetadata.version !== this.expected.version
      || this.releaseMetadata.protocol !== this.expected.protocol
    ) {
      throw new Error('导演台发布元数据不匹配目标版本或通信协议');
    }
    return { expandedBytes: this.expandedBytes, entryCount: this.entryCount };
  }
}

export function inspectReleaseArchive(archive, expected) {
  if (!Buffer.isBuffer(archive) || archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) {
    throw new Error('导演台压缩包大小无效');
  }
  const inspector = new TarInspector(expected);
  inspector.write(gunzipSync(archive, { maxOutputLength: MAX_TAR_STREAM_BYTES }));
  return inspector.finish();
}

async function inspectReleaseArchiveFile(archivePath, expected) {
  const inspector = new TarInspector(expected);
  const gunzip = createGunzip();
  createReadStream(archivePath).pipe(gunzip);
  for await (const chunk of gunzip) inspector.write(Buffer.from(chunk));
  return inspector.finish();
}

export function buildReleaseManifest(current, release) {
  return {
    schemaVersion: current.schemaVersion,
    repository: current.repository,
    version: release.version,
    artifact: release.artifact,
    url: release.url,
    sha256: release.sha256,
    protocol: current.protocol,
    downloadBytes: release.downloadBytes,
    expandedBytes: release.expandedBytes,
  };
}

async function downloadBuffer(url, label, maxBytes = MAX_ARCHIVE_BYTES) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'AI-Canvas/director-desk-release-updater' },
    redirect: 'follow',
  });
  if (!response.ok || !response.body) {
    throw new Error(`下载${label}失败: HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > maxBytes) {
    throw new Error(`${label}超过下载限制`);
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error(`${label}超过下载限制`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

async function downloadArchive(url, archivePath) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'AI-Canvas/director-desk-release-updater' },
    redirect: 'follow',
  });
  if (!response.ok || !response.body) {
    throw new Error(`下载导演台发布包失败: HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_ARCHIVE_BYTES) {
    throw new Error('导演台发布包超过 100 MB 下载限制');
  }

  const file = await open(archivePath, 'wx');
  const hash = createHash('sha256');
  let total = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_ARCHIVE_BYTES) {
        throw new Error('导演台发布包超过 100 MB 下载限制');
      }
      hash.update(buffer);
      await file.write(buffer);
    }
    await file.sync();
  } finally {
    await file.close();
  }
  return { downloadBytes: total, sha256: hash.digest('hex') };
}

async function replaceManifestAtomically(manifest) {
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  const temporaryPath = `${MANIFEST_PATH}.${process.pid}.tmp`;
  const backupPath = `${MANIFEST_PATH}.${process.pid}.bak`;
  await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
  try {
    try {
      await rename(temporaryPath, MANIFEST_PATH);
    } catch (error) {
      if (process.platform !== 'win32' || !['EEXIST', 'EPERM'].includes(error.code)) throw error;
      await rename(MANIFEST_PATH, backupPath);
      try {
        await rename(temporaryPath, MANIFEST_PATH);
        await rm(backupPath, { force: true });
      } catch (replacementError) {
        await rename(backupPath, MANIFEST_PATH).catch(() => {});
        throw replacementError;
      }
    }
  } finally {
    await rm(temporaryPath, { force: true });
    await rm(backupPath, { force: true });
  }
}

export async function main(tagInput = process.argv[2]) {
  const { tag, version } = normalizeReleaseTag(tagInput);
  const current = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  if (current.schemaVersion !== 1 || current.repository !== REPOSITORY || current.protocol !== 'tauri-event-v1') {
    throw new Error('当前导演台发布清单的仓库或协议边界无效');
  }

  const artifact = `director-desk-${tag}.tar.gz`;
  const url = `https://github.com/${REPOSITORY}/releases/download/${tag}/${artifact}`;
  console.log(`正在读取 ${REPOSITORY} ${tag}...`);
  const checksumBuffer = await downloadBuffer(`${url}.sha256`, 'SHA-256 文件', 64 * 1024);
  const expectedSha256 = parseChecksumFile(checksumBuffer.toString('utf8'), artifact);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-canvas-director-desk-'));
  const archivePath = join(temporaryDirectory, artifact);
  let next;
  try {
    const download = await downloadArchive(url, archivePath);
    if (download.sha256 !== expectedSha256) {
      throw new Error(`导演台发布包 SHA-256 校验失败，期望 ${expectedSha256}，实际 ${download.sha256}`);
    }
    const inspection = await inspectReleaseArchiveFile(archivePath, {
      version,
      protocol: current.protocol,
    });
    next = buildReleaseManifest(current, {
      tag,
      version,
      artifact,
      url,
      sha256: download.sha256,
      downloadBytes: download.downloadBytes,
      expandedBytes: inspection.expandedBytes,
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  if (JSON.stringify(current) === JSON.stringify(next)) {
    console.log(`导演台发布清单已是 ${tag}，无需更新。`);
    return next;
  }

  await replaceManifestAtomically(next);
  console.log(`已更新导演台发布清单到 ${tag}。`);
  console.log(`下载大小: ${next.downloadBytes} 字节，展开大小: ${next.expandedBytes} 字节。`);
  return next;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
