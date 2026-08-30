import { describe, expect, it } from 'vitest';
import {
  pruneVideoEditorSources,
  type SourceState,
} from '../../src/components/videoEditor/useVideoEditorSources';

function source(url: string): SourceState {
  return { url, probe: null, thumbnails: [`${url}#thumb`] };
}

describe('video editor source cache', () => {
  it('drops sources that are no longer referenced by any clip', () => {
    const keep = source('asset://keep.mp4');
    const remove = source('asset://remove.mp4');

    expect(pruneVideoEditorSources({
      [keep.url]: keep,
      [remove.url]: remove,
    }, [keep.url])).toEqual({ [keep.url]: keep });
  });

  it('preserves object identity when no cache entry needs pruning', () => {
    const keep = source('asset://keep.mp4');
    const previous = { [keep.url]: keep };

    expect(pruneVideoEditorSources(previous, [keep.url])).toBe(previous);
  });
});
