/** 编辑器尚未刷新时，保留 Store 在输入基线之后自动追加的节点引用。 */
export function mergeAppendedNodeMentions(
  previousValue: string,
  editedValue: string,
  currentValue: string,
): string {
  if (currentValue === previousValue || !currentValue.startsWith(previousValue)) return editedValue;
  const appended = currentValue.slice(previousValue.length);
  // 只合并纯节点引用追加；其他外部正文修改不猜测合并方式。
  if (!/^(?:\s*@\{[^:}]+:[^}]+\})+\s*$/.test(appended)) return editedValue;
  const mentioned = new Set([...editedValue.matchAll(/@\{([^:}]+):[^}]+\}/g)].map((match) => match[1]));
  let nextValue = editedValue;
  for (const match of appended.matchAll(/@\{([^:}]+):[^}]+\}/g)) {
    if (mentioned.has(match[1])) continue;
    const separator = nextValue && !/\s$/.test(nextValue) ? ' ' : '';
    nextValue += separator + match[0];
    mentioned.add(match[1]);
  }
  return nextValue;
}
