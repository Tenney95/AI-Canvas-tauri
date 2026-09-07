import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

describe('built-in panorama distribution', () => {
  it('pins the existing renderer without a Git-installed viewer or build hook', () => {
    const manifest = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    expect(manifest.dependencies.pannellum).toBe('2.5.7');
    expect(lock.packages[''].dependencies.pannellum).toBe('2.5.7');
    expect(lock.packages['node_modules/pannellum'].version).toBe('2.5.7');
    expect(manifest.dependencies['xiaoluo-vr-panorama']).toBeUndefined();
    expect(lock.packages['node_modules/xiaoluo-vr-panorama']).toBeUndefined();
    expect(read('package-lock.json')).not.toContain('XiaoLuo-Panorama.git');
  });

  it('loads renderer and viewer styles through the main entry before host overrides', () => {
    const entry = read('src/index.css');
    expect(entry).toContain("@import './styles/panorama-core.css';");
    expect(entry).toContain("@import './styles/panorama-viewer.css';");
    expect(entry.indexOf('panorama-viewer.css')).toBeLessThan(entry.indexOf('nodes-panorama.css'));
    const directory = new URL('../../src/components/nodes/panorama/', import.meta.url);
    const components = readdirSync(directory, { recursive: true }).filter((file) => String(file).endsWith('.tsx'));
    for (const file of components) {
      const source = readFileSync(new URL(String(file).replaceAll('\\', '/'), directory), 'utf8');
      expect(source).not.toMatch(/(?:import|from)\s*['"][^'"]+\.css['"]/);
      expect(source).not.toContain('xiaoluo-vr-panorama');
    }
  });

  it('ships attribution and removes upstream-only font, proxy and Tailwind build requirements', () => {
    const css = read('src/styles/panorama-viewer.css');
    expect(css).not.toMatch(/@import|@source|@theme|@custom-variant|!important|https?:\/\//);
    const viewer = read('src/components/nodes/panorama/internal/PanoramaViewer.tsx');
    expect(viewer).not.toContain('/api/proxy-download');
    expect(viewer).not.toContain('fetch(');
    expect(read('public/licenses/XiaoLuo-Panorama-LICENSE.txt')).toContain('Apache License');
    expect(read('public/licenses/XiaoLuo-Panorama-NOTICE.txt')).toContain('c743a39041b8049e1edfa3041311ab996aa1ff8f');
  });
});
