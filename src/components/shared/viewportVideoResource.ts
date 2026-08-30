export function releaseViewportVideoElement(video: Pick<
  HTMLVideoElement,
  'pause' | 'removeAttribute' | 'load'
> | null): void {
  if (!video) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
}
