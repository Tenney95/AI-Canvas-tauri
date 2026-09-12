import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../src/components/videoEditor/VideoEditorWindow.tsx', import.meta.url),
  'utf8',
);

describe('video editor config isolation', () => {
  it('loads ordinary settings without reading provider secrets', () => {
    expect(source).toContain('loadConfigWithoutSecrets as loadConfig');
    expect(source).not.toMatch(/^\s{2}loadConfig,$/m);
  });
});
