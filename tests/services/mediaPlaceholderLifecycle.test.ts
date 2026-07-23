import { beforeEach, describe, expect, it } from 'vitest';
import { cancelProjectCanvasDerivations } from '../../src/services/canvasDerivationGuard';
import {
  MEDIA_PLACEHOLDER_STALE_ERROR,
  registerMediaPlaceholderLifecycle,
  settleMediaPlaceholderLifecycle,
} from '../../src/services/chat/mediaPlaceholderLifecycle';
import { useAppStore } from '../../src/store/useAppStore';
import type { MediaGenerationIntent, MediaGenerationResult } from '../../src/types/media';

const intent: MediaGenerationIntent = {
  kind: 'image',
  prompt: 'test image',
  modelRef: 'apimart/test',
  deliveryMode: 'both',
};

const artifact: MediaGenerationResult = {
  id: 'artifact-1',
  kind: 'image',
  url: 'https://example.com/image.png',
  sourceUrl: 'https://example.com/image.png',
  prompt: 'test image',
  modelId: 'test',
  provider: 'apimart',
  deliveryMode: 'both',
  createdAt: 1,
};

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-1',
    projects: [{ id: 'project-1', name: 'Project 1', createdAt: 1, updatedAt: 1 }],
    nodes: [],
    edges: [],
    groups: [],
    canvasRevision: 0,
  });
});

describe('media placeholder lifecycle', () => {
  it('settles a placeholder while its project and revision remain current', () => {
    const nodeId = useAppStore.getState().createMediaPlaceholder(intent, { x: 0, y: 0 });
    const lifecycle = registerMediaPlaceholderLifecycle(nodeId);

    expect(lifecycle).not.toBeNull();
    expect(settleMediaPlaceholderLifecycle(lifecycle!, artifact)).toBe(true);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({
      artifactId: 'artifact-1',
      status: 'success',
    });
    expect(useAppStore.getState().canvasRevision).toBe(1);
  });

  it('marks the old placeholder as recoverable before switching projects', () => {
    const nodeId = useAppStore.getState().createMediaPlaceholder(intent, { x: 0, y: 0 });
    const lifecycle = registerMediaPlaceholderLifecycle(nodeId);

    cancelProjectCanvasDerivations('project-1');

    expect(useAppStore.getState().nodes[0].data).toMatchObject({
      status: 'error',
      error: MEDIA_PLACEHOLDER_STALE_ERROR,
    });
    expect(settleMediaPlaceholderLifecycle(lifecycle!, artifact)).toBe(false);
    expect(useAppStore.getState().nodes[0].data.artifactId).toBeUndefined();
  });

  it('does not settle after another canvas write changes the revision', () => {
    const nodeId = useAppStore.getState().createMediaPlaceholder(intent, { x: 0, y: 0 });
    const lifecycle = registerMediaPlaceholderLifecycle(nodeId);
    useAppStore.getState().incrementRevision();

    expect(settleMediaPlaceholderLifecycle(lifecycle!, artifact)).toBe(false);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({
      status: 'error',
      error: MEDIA_PLACEHOLDER_STALE_ERROR,
    });
  });
});
