import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AnnotationLayer,
  IMAGE_ANNOTATION_LAYER_VERSION,
  isImageAnnotationLayer,
  resizeImageAnnotationLayer,
  type ImageAnnotationLayer as ImageAnnotationLayerData,
} from '@tenney95/xiaoluo-image-editor';

const layer: ImageAnnotationLayerData = {
  version: IMAGE_ANNOTATION_LAYER_VERSION,
  width: 1000,
  height: 500,
  annotations: [
    {
      id: 'rect-1',
      type: 'rectangle',
      color: '#ef4444',
      strokeWidth: 4,
      x: 100,
      y: 50,
      width: 200,
      height: 120,
    },
    {
      id: 'brush-1',
      type: 'brush',
      color: '#10b981',
      strokeWidth: 8,
      points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
    },
    {
      id: 'arrow-1',
      type: 'arrow',
      color: '#3b82f6',
      strokeWidth: 6,
      startX: 50,
      startY: 60,
      endX: 400,
      endY: 220,
    },
    {
      id: 'marker-1',
      type: 'marker',
      color: '#f59e0b',
      strokeWidth: 3,
      number: 1,
      x: 600,
      y: 240,
      size: 24,
    },
    {
      id: 'text-1',
      type: 'text',
      color: '#ffffff',
      strokeWidth: 2,
      text: '第一行\n第二行',
      x: 420,
      y: 300,
      fontSize: 32,
    },
  ],
};

describe('ImageAnnotationLayer', () => {
  it('validates the persisted layer schema and rejects incomplete annotations', () => {
    expect(isImageAnnotationLayer(layer)).toBe(true);
    expect(isImageAnnotationLayer({
      ...layer,
      annotations: [{ id: 'broken', type: 'marker', color: '#fff', strokeWidth: 2 }],
    })).toBe(false);
  });

  it('maps annotations into a new native image coordinate space', () => {
    const resized = resizeImageAnnotationLayer(layer, 2000, 1000);
    expect(resized.width).toBe(2000);
    expect(resized.height).toBe(1000);
    expect(resized.annotations[0]).toMatchObject({
      type: 'rectangle',
      x: 200,
      y: 100,
      width: 400,
      height: 240,
      strokeWidth: 8,
    });
    expect(resized.annotations[3]).toMatchObject({
      type: 'marker',
      x: 1200,
      y: 480,
      size: 48,
    });
  });

  it('renders every annotation as an independent transparent SVG layer', () => {
    const html = renderToStaticMarkup(
      <AnnotationLayer layer={layer} className="test-layer" fit="cover" />,
    );
    expect(html).toContain('viewBox="0 0 1000 500"');
    expect(html).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(html).toContain('data-annotation-id="rect-1"');
    expect(html).toContain('data-annotation-id="brush-1"');
    expect(html).toContain('data-annotation-id="arrow-1"');
    expect(html).toContain('data-annotation-id="marker-1"');
    expect(html).toContain('data-annotation-id="text-1"');
    expect(html).not.toContain('<img');
  });
});
