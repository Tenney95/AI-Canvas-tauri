import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('离线手册从单个 HTML 加载交互脚本，内容与维护源一致', () => {
  const html = readFileSync(new URL('../../site/manual.html', import.meta.url), 'utf8');
  expect(html.match(/<script\b[^>]*>/gi)).toEqual(['<script id="manual-interactions">']);
  const generator = fileURLToPath(new URL('../../scripts/sync-site-manual.mjs', import.meta.url));
  execFileSync(process.execPath, [generator, '--check']);
});
