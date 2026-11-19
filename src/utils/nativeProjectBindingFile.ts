/** 原生作品目录的本地归属标记保留给项目仓储。 */
export const NATIVE_PROJECT_BINDING_FILE = '.ai-canvas-native-project.json';

export function isNativeProjectBindingFile(nameOrPath: string): boolean {
  const name = nameOrPath.slice(Math.max(nameOrPath.lastIndexOf('/'), nameOrPath.lastIndexOf('\\')) + 1);
  return name.toLowerCase() === NATIVE_PROJECT_BINDING_FILE;
}
