/** 两代不可变媒体文件路径；普通落盘文件必须先冻结到摘要目录。 */
export function isNativeMediaContentPath(path: unknown, sha256: unknown): boolean {
  return typeof path === 'string' && typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256)
    && (new RegExp(`^media/${sha256}\\.[a-z0-9]{1,16}$`).test(path)
      || new RegExp(`^imports/retained-${sha256}/${sha256}\\.[a-z0-9]{1,16}$`).test(path));
}

export function nativeMediaContentDigest(path: unknown): string | undefined {
  if (typeof path !== 'string') return undefined;
  const digest = /(?:^media\/|^imports\/retained-)([a-f0-9]{64})/.exec(path)?.[1];
  return digest && isNativeMediaContentPath(path, digest) ? digest : undefined;
}

/** 作品主根的相对路径可包含原生子根前缀。写入守卫也覆盖同一文件的大小写别名。 */
export function isNativeProjectMediaContentPath(path: unknown): boolean {
  if (typeof path !== 'string') return false;
  const relativePath = path.toLowerCase().replace(/^roots\/r2-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\//, '');
  return nativeMediaContentDigest(relativePath) !== undefined;
}
