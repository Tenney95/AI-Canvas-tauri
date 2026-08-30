import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/hooks/useImageViewportGesture', () => ({
  useImageViewportGesture: () => ({
    containerRef: vi.fn(),
    containerEl: { current: null },
    scale: 1,
    tx: 0,
    ty: 0,
    dragging: false,
    gesturing: false,
    cursor: 'default',
    onPointerDown: vi.fn(),
    reset: vi.fn(),
    zoomTo: vi.fn(),
  }),
}));

import ZoomableImage from '../../src/components/shared/ZoomableImage';

const imageNodeSource = readFileSync(
  new URL('../../src/components/nodes/ImageNode.tsx', import.meta.url),
  'utf8',
);
const zoomableImageSource = readFileSync(
  new URL('../../src/components/shared/ZoomableImage.tsx', import.meta.url),
  'utf8',
);
const nodesCssSource = readFileSync(
  new URL('../../src/styles/nodes.css', import.meta.url),
  'utf8',
);
const nodesImageCssSource = readFileSync(
  new URL('../../src/styles/nodes-image.css', import.meta.url),
  'utf8',
);

describe('image fullscreen memory guard', () => {
  it('reuses the displayed source and suspends the canvas preview without origin flight', () => {
    const previewStart = imageNodeSource.indexOf(
      '<FullscreenOverlay',
      imageNodeSource.indexOf('Fullscreen preview'),
    );
    const previewEnd = imageNodeSource.indexOf('</FullscreenOverlay>', previewStart);
    const fullscreenPreview = imageNodeSource.slice(previewStart, previewEnd);
    const canvasPreviewStart = imageNodeSource.indexOf('className="image-preview-container"');
    const canvasPreviewEnd = imageNodeSource.indexOf(') : isUploading ? (', canvasPreviewStart);
    const canvasPreview = imageNodeSource.slice(canvasPreviewStart, canvasPreviewEnd);
    const suspendedPreviewStart = canvasPreview.indexOf('{!shouldSuspendCanvasPreview && (');
    const suspendedPreviewEnd = canvasPreview.lastIndexOf('</>');
    const suspendedPreview = canvasPreview.slice(suspendedPreviewStart, suspendedPreviewEnd);

    expect(fullscreenPreview).toContain(
      'className="fullscreen-overlay--image-preview image-node-fullscreen-overlay"',
    );
    expect(fullscreenPreview).toContain('src={displaySrc}');
    expect(fullscreenPreview).not.toContain('originRect=');
    expect(imageNodeSource).not.toContain('fullscreenOrigin');
    expect(imageNodeSource).not.toContain('imagePreviewRef');
    expect(suspendedPreviewStart).toBeGreaterThan(-1);
    expect(suspendedPreviewEnd).toBeGreaterThan(suspendedPreviewStart);
    expect(imageNodeSource).toContain('const shouldSuspendCanvasPreview = isFullscreen');
    expect(imageNodeSource).toContain('|| isMatting');
    expect(imageNodeSource).toContain('|| isAnnotate');
    expect(imageNodeSource).toContain('|| isCompose');
    expect(suspendedPreview).toContain('src={displaySrc}');
    expect(suspendedPreview).toContain('data.mattingMask');
    expect(suspendedPreview).toContain('annotationLayer');
    expect(suspendedPreview).toContain('isUpscaling');
    expect(suspendedPreview).toContain('isMattingRunning');
  });

  it('does not permanently promote the idle image or retain the layout flight path', () => {
    const html = renderToStaticMarkup(<ZoomableImage src="asset://preview.png" />);

    expect(html).not.toMatch(/will-change:\s*transform/);
    expect(zoomableImageSource).not.toContain('originRect');
    expect(zoomableImageSource).not.toContain('useLayoutEffect');
    expect(zoomableImageSource).not.toContain('.animate(');
  });

  it('shows an intentional static placeholder without decoding another image', () => {
    const placeholderStart = imageNodeSource.indexOf('className="image-preview-suspended');
    const placeholderEnd = imageNodeSource.indexOf('{!shouldSuspendCanvasPreview && (', placeholderStart);
    const placeholder = imageNodeSource.slice(placeholderStart, placeholderEnd);

    expect(placeholderStart).toBeGreaterThan(-1);
    expect(placeholderEnd).toBeGreaterThan(placeholderStart);
    expect(imageNodeSource).toContain('{shouldSuspendCanvasPreview && (');
    expect(placeholder).toContain("{t('编辑中')}");
    expect(placeholder).not.toContain('src={displaySrc}');
    expect(placeholder).not.toContain('<img');
    expect(placeholder).not.toContain('<canvas');
    expect(placeholder).not.toContain('blur');
    expect(placeholder).not.toContain('filter');
    expect(placeholder).not.toContain('will-change');
    expect(imageNodeSource).not.toContain('prepareSuspendedCanvasPreview');
    expect(imageNodeSource).not.toContain('createObjectURL');
    expect(imageNodeSource).not.toContain('toBlob');
    expect(imageNodeSource).toContain('image-node-fullscreen-overlay');
  });

  it('disables expensive effects only for the image fullscreen overlay', () => {
    const sharedOverlayIndex = nodesCssSource.indexOf('.fullscreen-overlay--transparent {');
    const imageOverlayIndex = nodesCssSource.indexOf(
      '.fullscreen-overlay--transparent.fullscreen-overlay--image-preview',
    );

    expect(imageOverlayIndex).toBeGreaterThan(sharedOverlayIndex);
    expect(nodesCssSource).toMatch(
      /\.fullscreen-overlay--transparent\.fullscreen-overlay--image-preview\s*\{(?=[^}]*-webkit-backdrop-filter:\s*none)(?=[^}]*backdrop-filter:\s*none)[^}]*\}/s,
    );
    expect(nodesCssSource).toMatch(
      /\.fullscreen-overlay--image-preview\s+\.zoomable-image-stage\s*\{(?=[^}]*animation:\s*none)(?=[^}]*will-change:\s*auto)[^}]*\}/s,
    );
  });

  it('uses a static depth mask for image editors instead of full-window blur', () => {
    const depthMaskStart = nodesImageCssSource.indexOf('body > :is(');
    const depthMaskEnd = nodesImageCssSource.indexOf('\n}', depthMaskStart);
    const depthMask = nodesImageCssSource.slice(depthMaskStart, depthMaskEnd);

    expect(depthMaskStart).toBeGreaterThan(-1);
    expect(depthMaskEnd).toBeGreaterThan(depthMaskStart);
    expect(depthMask).toContain('.fullscreen-overlay--transparent.composer-overlay');
    expect(depthMask).toContain('.fullscreen-overlay--transparent.crop-overlay');
    expect(depthMask).toContain('.matting-overlay');
    expect(depthMask).toContain('.point-edit-overlay.point-edit-overlay');
    expect(depthMask).toContain('.fullscreen-overlay--transparent.customgrid-overlay');
    expect(depthMask).toContain('.fullscreen-overlay.camera-studio-overlay');
    expect(depthMask).toContain('.fullscreen-overlay--transparent.image-node-fullscreen-overlay');
    expect(depthMask).toContain(
      'radial-gradient(ellipse at center, var(--black-alpha-30) 0%, var(--black-alpha-60) 100%)',
    );
    expect(depthMask).toContain(
      'linear-gradient(var(--black-alpha-50), var(--black-alpha-50))',
    );
    expect(depthMask).toContain('var(--black-alpha-60)');
    expect(depthMask).toContain('-webkit-backdrop-filter: none');
    expect(depthMask).toContain('backdrop-filter: none');
    expect(depthMask).not.toMatch(/backdrop-filter:\s*blur/);
  });
});
