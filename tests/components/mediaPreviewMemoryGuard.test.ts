import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

const historyDialogSource = readSource(
  '../../src/components/nodes/shared/image/ImageGenerationHistoryDialog.tsx',
);
const connectedPreviewSource = readSource(
  '../../src/components/nodes/shared/ConnectedNodesPreview.tsx',
);
const panoramaNodeSource = readSource('../../src/components/nodes/PanoramaNode.tsx');
const videoNodeSource = readSource('../../src/components/nodes/VideoNode.tsx');
const nodesCssSource = readSource('../../src/styles/nodes.css');
const nodesImageCssSource = readSource('../../src/styles/nodes-image.css');
const cropCssSource = readSource('../../src/styles/crop.css');
const composerCssSource = readSource('../../src/styles/composer.css');
const cameraStudioCssSource = readSource('../../src/styles/camera-studio.css');
const panoramaCssSource = readSource('../../src/styles/nodes-panorama.css');
const fullscreenOverlaySource = readSource('../../src/components/shared/FullscreenOverlay.tsx');
const cameraStudioSource = readSource('../../src/components/nodes/shared/image/CameraStudioPanel.tsx');
const expandEditorSource = readSource('../../src/components/nodes/shared/image/ExpandEditor.tsx');
const cropEditorSource = readSource('../../src/components/nodes/shared/image/CropEditor.tsx');
const composerToolbarSource = readSource(
  '../../src/components/nodes/shared/image/composer/ComposerToolbar.tsx',
);
const composerEditorSource = readSource(
  '../../src/components/nodes/shared/image/composer/ImageComposerEditor.tsx',
);
const useComposerSource = readSource(
  '../../src/components/nodes/shared/image/composer/useComposer.ts',
);
const videoEditorWindowSource = readSource(
  '../../src/components/videoEditor/VideoEditorWindow.tsx',
);
const videoEditorMediaServiceSource = readSource(
  '../../src/services/videoEditorMediaService.ts',
);

describe('media preview memory guards', () => {
  it('uses the no-backdrop preview scope and removes duplicate connected thumbnails', () => {
    expect(historyDialogSource).toMatch(
      /<FullscreenOverlay[\s\S]*?hidePanel[\s\S]*?className="fullscreen-overlay--image-preview"/,
    );
    expect(connectedPreviewSource).toContain('{fullscreenPreview === null && (');
    expect(connectedPreviewSource).toMatch(
      /isOpen=\{fullscreenPreview !== null\}[\s\S]*?className="fullscreen-overlay--image-preview"/,
    );
    expect(historyDialogSource).toContain("import ViewportImage from '../../../shared/ViewportImage';");
    expect(historyDialogSource).toMatch(/<ViewportImage[\s\S]*?unloadDelayMs=\{800\}/);
    expect(historyDialogSource).toContain('{preview === null && <ModalOverlay');
  });

  it('serializes composer imports and invalidates deferred editor work on close', () => {
    expect(useComposerSource).toContain('const enqueueImageOperation = useCallback');
    expect(composerEditorSource).toContain("addImageLayer(imageUrl, '底图', (img) => {");
    expect(composerEditorSource).toContain('const enqueueImageImport = useCallback');
    expect(composerEditorSource).toContain('imageImportQueueRef.current');
    expect(composerEditorSource).toContain('cancelAnimationFrame(exportFrameRef.current)');
    expect(composerEditorSource).toContain('dataUrl = await canvasToDataUrl(exportCanvas)');
    expect(expandEditorSource).toContain('const operationEpochRef = useRef(0)');
    expect(expandEditorSource).toContain('if (!isCurrentOperation()) return;');
    expect(useComposerSource).toContain('imageLoadQueueRef.current');
    expect(useComposerSource).toContain('additional.bytes');
    expect(useComposerSource).toContain('src,');
    expect(useComposerSource).not.toContain('src: img.src');
    expect(composerToolbarSource).toContain('addImageFileLayer(file, file.name)');
    expect(composerToolbarSource).not.toContain('new FileReader()');
  });

  it('reuses one preflighted crop/expand preview and keeps crop delivery locked through save', () => {
    expect(cropEditorSource).toContain("createSafeImagePreviewSource(imageUrl, '裁切源图')");
    expect(expandEditorSource).toContain("createSafeImagePreviewSource(imageUrl, '扩图源图')");
    expect(cropEditorSource).not.toContain('loadDrawableSource');
    expect(expandEditorSource).not.toContain('loadSourceImage');
    expect(cropEditorSource).toMatch(/delivered = true;\s*await onSave\(/);
    expect(cropEditorSource).toContain('if (busyRef.current) return;');
  });

  it('bounds and releases video-editor image bitmaps and export surfaces', () => {
    expect(videoEditorWindowSource).toContain('const MAX_RENDER_IMAGE_BITMAP_BYTES = 256 * 1024 * 1024;');
    expect(videoEditorWindowSource).toMatch(
      /retainedBytes \+ bytes > MAX_RENDER_IMAGE_BITMAP_BYTES[\s\S]*?bitmap\.close\(\)/,
    );
    expect(videoEditorWindowSource.match(/createBudgetedRenderBitmap\(/g)).toHaveLength(3);
    expect(videoEditorWindowSource.match(/closeRenderSourceBitmaps\(renderSources\.values\(\)\)/g)).toHaveLength(2);
    expect(videoEditorMediaServiceSource).toMatch(
      /export async function exportComposite[\s\S]*?finally \{\s*await pendingOutput\?\.cancel\(\)[\s\S]*?surface\.width = 1;\s*surface\.height = 1;/,
    );
  });

  it('unmounts the compact panorama renderer while fullscreen WebGL is active', () => {
    expect(panoramaNodeSource).toContain('{isFullscreen && hasImage ? (');
    expect(panoramaNodeSource).toMatch(
      /const toggleFullscreen[\s\S]*?panoActiveBeforeFullscreenRef\.current = panoActive;[\s\S]*?setPanoActive\(false\);/,
    );
    expect(panoramaNodeSource).toContain('setPanoActive(panoActiveBeforeFullscreenRef.current);');
    expect(panoramaNodeSource).toMatch(
      /\) : show360 \? \([\s\S]*?<XiaoLuoPanoramaViewer/,
    );
    expect(panoramaNodeSource).toMatch(/className="pano-original-overlay"[\s\S]*?unmountOnClose/);
  });

  it('moves video playback between one compact player and one fullscreen player', () => {
    expect(videoNodeSource).toContain('{data.videoUrl && !isFullscreen ? (');
    expect(videoNodeSource).toContain('compactPlaybackRestoreRef.current = {');
    expect(videoNodeSource).toContain('shouldPlay: fullscreenPlaybackRef.current.wasPlaying');
    expect(videoNodeSource).toContain('releaseVideoElement(fullscreenVideo);');
    expect(videoNodeSource).toMatch(
      /function releaseVideoElement[\s\S]*?removeAttribute\('src'\)[\s\S]*?video\.load\(\)/,
    );
    expect(videoNodeSource).toMatch(/const cleanup = \(\) => \{[\s\S]*?releaseVideoElement\(video\)/);
    expect(videoNodeSource).toMatch(
      /className="fullscreen-overlay--image-preview"[\s\S]*?ref=\{setFullscreenVideoElement\}/,
    );
    expect(videoNodeSource).toMatch(
      /const setFullscreenVideoElement[\s\S]*?if \(!video\) return;[\s\S]*?fullscreenVideoRef\.current = video;/,
    );
    expect(videoNodeSource).toContain('const VIDEO_FRAME_MAX_DIMENSION = 1280;');
    expect(videoNodeSource).toMatch(
      /async function captureVideoFrame[\s\S]*?fitVideoFrameDimensions\(video, VIDEO_FRAME_MAX_DIMENSION\)/,
    );
    expect(videoNodeSource).toMatch(
      /captureVideoFrame[\s\S]*?canvas\.toBlob\([\s\S]*?'image\/jpeg'[\s\S]*?blobToDataUrl\(blob\)/,
    );
    expect(videoNodeSource).not.toContain("canvas.toDataURL('image/png')");
  });

  it('disables only editor-scoped whole-window blur and permanent promotion', () => {
    expect(fullscreenOverlaySource.match(/const panelVariants = \{[\s\S]*?\n\};/)?.[0]).not.toContain('filter:');
    expect(fullscreenOverlaySource).toContain('const shouldUnmountImmediately = hidePanel || unmountOnClose;');
    expect(cameraStudioSource).toMatch(/className="camera-studio-overlay"[\s\S]*?unmountOnClose/);
    expect(nodesImageCssSource).toMatch(
      /\.matting-overlay\s*\{(?=[^}]*-webkit-backdrop-filter:\s*none)(?=[^}]*backdrop-filter:\s*none)[^}]*\}/s,
    );
    expect(nodesImageCssSource).not.toMatch(/\.matting-zoom\s*\{[^}]*will-change/s);
    expect(nodesImageCssSource).toMatch(
      /\.fullscreen-overlay--transparent\.customgrid-overlay\s*\{[^}]*backdrop-filter:\s*none/s,
    );
    expect(nodesImageCssSource).toMatch(
      /\.point-edit-overlay\.point-edit-overlay\s*\{[^}]*backdrop-filter:\s*none/s,
    );
    expect(cropCssSource).toMatch(
      /\.fullscreen-overlay--transparent\.crop-overlay\s*\{[^}]*backdrop-filter:\s*none/s,
    );
    expect(composerCssSource).toMatch(
      /\.fullscreen-overlay--transparent\.composer-overlay\s*\{[^}]*backdrop-filter:\s*none/s,
    );
    expect(composerCssSource.match(/@keyframes composerRootBloom\s*\{[\s\S]*?\n\}/)?.[0]).not.toContain('filter:');
    expect(nodesCssSource).toMatch(
      /\.fullscreen-overlay--image-preview \.fullscreen-video-view\s*\{[^}]*animation:\s*none/s,
    );
    expect(nodesCssSource).toMatch(
      /\.fullscreen-video-view\s*\{(?=[^}]*width:\s*92vw)(?=[^}]*height:\s*92vh)(?=[^}]*object-fit:\s*contain)[^}]*\}/s,
    );
    expect(cameraStudioCssSource).toMatch(
      /\.fullscreen-overlay\.camera-studio-overlay\s*\{[^}]*backdrop-filter:\s*none/s,
    );
    expect(panoramaCssSource).toMatch(
      /\.fullscreen-overlay\.pano-original-overlay\s*\{[^}]*backdrop-filter:\s*none/s,
    );
  });
});
