/**
 * Store utilities — pure functions: ID generation, image dimension calculation
 */
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';

export const generateId = () => Math.random().toString(36).substring(2, 11);

export function generateProjectId(): string {
  return crypto.randomUUID();
}

export function computeImageNodeDimensions(dataUrl: string): Promise<{ nodeWidth: number; nodeHeight: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const naturalRatio = img.naturalWidth / img.naturalHeight;
      const maxWidth = 280;
      const minWidth = 160;
      let nodeWidth = img.naturalWidth;
      if (nodeWidth > maxWidth) nodeWidth = maxWidth;
      if (nodeWidth < minWidth) nodeWidth = minWidth;
      const contentWidth = nodeWidth - 4;
      const previewHeight = Math.round(contentWidth / naturalRatio);
      const nodeHeight = Math.max(120, previewHeight + 4);
      resolve({ nodeWidth, nodeHeight });
    };
    img.onerror = () => resolve({ nodeWidth: 280, nodeHeight: 158 });
    img.src = dataUrl;
  });
}

export function getNextDisplayId(nodes: Node<BaseNodeData>[]): number {
  let max = 9;
  for (const n of nodes) {
    const id = (n.data as BaseNodeData).displayId;
    if (typeof id === 'number' && id > max) max = id;
  }
  return max + 1;
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
