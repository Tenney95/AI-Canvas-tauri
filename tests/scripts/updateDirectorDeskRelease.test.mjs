import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildReleaseManifest,
  inspectReleaseArchive,
  normalizeReleaseTag,
  parseChecksumFile,
} from '../../scripts/update-director-desk-release.mjs';

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0');
  buffer.write(`${text}\0`, offset, length, 'ascii');
}

function createTarEntry(name, content, type = '0') {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, body.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function createReleaseArchive(entries) {
  return gzipSync(Buffer.concat([
    ...entries.map(([name, content]) => createTarEntry(name, content)),
    Buffer.alloc(1024),
  ]));
}

describe('update-director-desk-release', () => {
  it('normalizes an explicit semantic release tag', () => {
    expect(normalizeReleaseTag('v0.3.2')).toEqual({ tag: 'v0.3.2', version: '0.3.2' });
    expect(() => normalizeReleaseTag('latest')).toThrow('vX.Y.Z');
    expect(() => normalizeReleaseTag('v0.3.2/../../main')).toThrow('vX.Y.Z');
  });

  it('reads the checksum only when it belongs to the expected artifact', () => {
    const hash = 'a'.repeat(64);
    expect(parseChecksumFile(`${hash}  director-desk-v0.3.2.tar.gz\n`, 'director-desk-v0.3.2.tar.gz'))
      .toBe(hash);
    expect(() => parseChecksumFile(`${hash}  other.tar.gz\n`, 'director-desk-v0.3.2.tar.gz'))
      .toThrow('未包含目标产物');
  });

  it('inspects the archive entry, metadata and expanded byte count', () => {
    const metadata = JSON.stringify({
      name: '3d-director-desk',
      version: '0.3.2',
      protocol: 'tauri-event-v1',
    });
    const archive = createReleaseArchive([
      ['./index.html', '<!doctype html>'],
      ['./director-desk-release.json', metadata],
      ['./assets/app.js', 'console.log("ready")'],
    ]);

    expect(inspectReleaseArchive(archive, {
      version: '0.3.2',
      protocol: 'tauri-event-v1',
    })).toEqual({
      expandedBytes: Buffer.byteLength('<!doctype html>')
        + Buffer.byteLength(metadata)
        + Buffer.byteLength('console.log("ready")'),
      entryCount: 3,
    });
  });

  it('applies a validated GNU long-name record to the next file', () => {
    const metadata = JSON.stringify({
      name: '3d-director-desk',
      version: '0.3.2',
      protocol: 'tauri-event-v1',
    });
    const longPath = `./assets/${'nested/'.repeat(16)}app.js`;
    const archive = gzipSync(Buffer.concat([
      createTarEntry('./index.html', 'index'),
      createTarEntry('./director-desk-release.json', metadata),
      createTarEntry('././@LongLink', `${longPath}\0`, 'L'),
      createTarEntry('./assets/truncated-name', 'script'),
      Buffer.alloc(1024),
    ]));

    expect(inspectReleaseArchive(archive, {
      version: '0.3.2',
      protocol: 'tauri-event-v1',
    })).toEqual({
      expandedBytes: Buffer.byteLength('index') + Buffer.byteLength(metadata) + Buffer.byteLength('script'),
      entryCount: 3,
    });
  });

  it('rejects mismatched release metadata and unsafe archive paths', () => {
    const wrongMetadataArchive = createReleaseArchive([
      ['./index.html', 'ok'],
      ['./director-desk-release.json', JSON.stringify({
        name: '3d-director-desk',
        version: '0.3.1',
        protocol: 'tauri-event-v1',
      })],
    ]);
    expect(() => inspectReleaseArchive(wrongMetadataArchive, {
      version: '0.3.2',
      protocol: 'tauri-event-v1',
    })).toThrow('元数据不匹配');

    const unsafeArchive = createReleaseArchive([
      ['../index.html', 'unsafe'],
      ['director-desk-release.json', '{}'],
    ]);
    expect(() => inspectReleaseArchive(unsafeArchive, {
      version: '0.3.2',
      protocol: 'tauri-event-v1',
    })).toThrow('不安全路径');
  });

  it('builds the pinned manifest from verified release facts', () => {
    expect(buildReleaseManifest({
      schemaVersion: 1,
      repository: 'Tenney95/3d-director-desk',
      protocol: 'tauri-event-v1',
    }, {
      tag: 'v0.3.2',
      version: '0.3.2',
      artifact: 'director-desk-v0.3.2.tar.gz',
      url: 'https://github.com/Tenney95/3d-director-desk/releases/download/v0.3.2/director-desk-v0.3.2.tar.gz',
      sha256: 'b'.repeat(64),
      downloadBytes: 123,
      expandedBytes: 456,
    })).toEqual({
      schemaVersion: 1,
      repository: 'Tenney95/3d-director-desk',
      version: '0.3.2',
      artifact: 'director-desk-v0.3.2.tar.gz',
      url: 'https://github.com/Tenney95/3d-director-desk/releases/download/v0.3.2/director-desk-v0.3.2.tar.gz',
      sha256: 'b'.repeat(64),
      protocol: 'tauri-event-v1',
      downloadBytes: 123,
      expandedBytes: 456,
    });
  });
});
