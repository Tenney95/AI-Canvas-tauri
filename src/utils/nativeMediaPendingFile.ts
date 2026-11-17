/** 原生媒体发布暂存件只供恢复使用，不作为用户素材展示。 */
export function isNativeMediaPendingFile(nameOrPath: string): boolean {
  const name = nameOrPath.slice(Math.max(nameOrPath.lastIndexOf('/'), nameOrPath.lastIndexOf('\\')) + 1);
  return /^\.native-media-[a-f0-9]{64}(?:\.(?:png|jpg|webp|gif|mp4|webm|mov|mp3|wav|ogg|opus|aac|flac|pcm|json))?\.pending$/i.test(name);
}
