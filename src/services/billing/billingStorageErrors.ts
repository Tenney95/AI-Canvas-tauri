/** 账本目录诊断只保留固定原因，原始 IPC / 文件系统错误可能包含本机路径。 */
const NATIVE_STORAGE_REASONS = new Set([
  '账本存储服务不可用', '账本路径状态不可用', '无法确定原账本目录',
  '账本文件不可访问', '账本文件无法读取', '账本校验初始化失败',
  '账本完整性校验失败', '账本文件已损坏，原账本已保留',
  '账本结构校验失败', '目标文件不是支持的火山方舟账本',
  '目标目录中已存在火山方舟账本，请先选择其他目录',
  '账本目录不可写或目标文件已存在，原账本已保留', '原账本无法读取',
  '账本迁移初始化失败', '账本路径编码无效',
  '账本迁移失败，请检查磁盘空间和目录权限；原账本已保留',
  '账本初始化失败', '账本目录不可创建，请检查目录权限',
  '无法确定账本的文件保存根目录',
  '账本探测目录格式无效', '账本目录涉及应用私有区域，不能访问',
  '账本目录未获授权，请重新选择保存根目录或账本目录',
  '账本目录无法解析或不可访问，请检查目录权限',
  '账本目录不是普通目录或包含链接', '账本目录不是普通目录、不可访问或未获授权',
  '账本目录不可访问，请检查目录权限', '账本历史文件不是普通文件或包含链接',
  '账本历史文件无法读取或未获授权', '账本历史文件不可访问，请检查目录权限',
  '账本附属文件存在但主库缺失，请先恢复原账本',
  '桌面应用缺少账本命令，请更新或重启完整桌面应用',
  '账本目录未获应用授权，请重新选择目录', '账本目录没有读写权限，请检查文件夹权限',
  '磁盘空间不足，无法保存账本', '账本目录为只读，请选择可写目录',
  '账本正在被其他程序占用，请关闭占用后重试', '账本目录不是有效文件夹，请重新选择',
  '账本目录不存在，请重新选择目录',
]);

/** 将原生私有异常转换为公开错误；不把含路径或凭据的原对象附加为 cause。 */
export function createPublicBillingStorageError(error: unknown): Error {
  return new Error(getBillingStorageErrorMessage(error));
}

export function getBillingStorageErrorMessage(error: unknown): string {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (NATIVE_STORAGE_REASONS.has(message)) return message;
  if (/command\b[^\n]*(?:not found|unknown)|unknown command/i.test(message)) {
    return '桌面应用缺少账本命令，请更新或重启完整桌面应用';
  }
  if (/未获授权|未授权|forbidden|not allowed|not permitted/i.test(message)) {
    return '账本目录未获应用授权，请重新选择目录';
  }
  if (/权限|不可写|permission denied|access (?:is )?denied|os error (?:5|13)\b/i.test(message)) {
    return '账本目录没有读写权限，请检查文件夹权限';
  }
  if (/no space|disk full|storage full|os error (?:28|112)\b/i.test(message)) return '磁盘空间不足，无法保存账本';
  if (/read.only|只读/i.test(message)) return '账本目录为只读，请选择可写目录';
  if (/database (?:is )?(?:locked|busy)|sharing violation|os error 32\b/i.test(message)) return '账本正在被其他程序占用，请关闭占用后重试';
  if (/not a directory|不是.*目录|不是.*文件夹/i.test(message)) return '账本目录不是有效文件夹，请重新选择';
  if (/not found|does not exist|不存在/i.test(message)) return '账本目录不存在，请重新选择目录';
  return '账本目录同步失败，未能识别具体原因，请重试或更新桌面应用';
}
