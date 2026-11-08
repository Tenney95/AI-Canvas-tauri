/** 两代不可变媒体文件路径；普通落盘文件必须先冻结到摘要目录。 */
export function isNativeMediaContentPath(path: unknown, sha256: unknown): path is string {
  return typeof path === 'string' && typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256)
    && (new RegExp(`^media/${sha256}\\.[a-z0-9]{1,16}$`).test(path)
      || new RegExp(`^imports/retained-${sha256}/${sha256}\\.[a-z0-9]{1,16}$`).test(path));
}
