/** 原生提交守卫只有宿主在内存中登记；展示和路由可识别身份，无须加载保存／生成执行器。 */
const nativeGuards = new WeakSet<() => void | Promise<void>>();
export function registerNativeVideoSubmissionGuard<T extends () => void | Promise<void>>(guard: T): T {
  nativeGuards.add(guard);
  return guard;
}
export function isNativeVideoSubmissionGuard(guard: (() => void | Promise<void>) | undefined): boolean {
  return !!guard && nativeGuards.has(guard);
}
