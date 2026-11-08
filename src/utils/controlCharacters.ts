/** C0、DEL 和 C1 控制字符；显式字符码边界与项目持久化校验保持一致。 */
export function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code >= 127 && code <= 159;
  });
}
