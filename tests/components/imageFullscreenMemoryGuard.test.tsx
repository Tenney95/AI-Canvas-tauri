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
    const suspendedPreviewStart = canvasPreview.indexOf('{!isFullscreen && (');
    const suspendedPreviewEnd = canvasPreview.lastIndexOf('</>');
    const suspendedPreview = canvasPreview.slice(suspendedPreviewStart, suspendedPreviewEnd);

    expect(fullscreenPreview).toContain('className="fullscreen-overlay--image-preview"');
    expect(fullscreenPreview).toContain('src={displaySrc}');
    expect(fullscreenPreview).not.toContain('originRect=');
    expect(imageNodeSource).not.toContain('fullscreenOrigin');
    expect(imageNodeSource).not.toContain('imagePreviewRef');
    expect(suspendedPreviewStart).toBeGreaterThan(-1);
    expect(suspendedPreviewEnd).toBeGreaterThan(suspendedPreviewStart);
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
});
