export type SeriesSourcePart = 'original' | 'script';

export interface SeriesSourceChapter {
  id: string;
  title: string;
  ordinal: number;
  start: number;
  end: number;
}

/** 仅供当前读取/浏览会话使用，正文和索引不进入 Store 或 IndexedDB。 */
export interface SeriesSourceSnapshot {
  projectId: string;
  seriesId: string;
  part: SeriesSourcePart;
  version: string;
  text: string;
  chapters: SeriesSourceChapter[];
}

export interface SeriesSourceReference {
  seriesId: string;
  part: SeriesSourcePart;
  version: string;
  chapterId: string;
}
