/** 输出历史统一留存规则；仅操作调用方已经打开的事务，不打开任何数据库。 */
export function projectHistoryRange(projectId: string, cursor?: { timestamp: number; id: string } | null): IDBKeyRange {
  const lower: [string, number, string] = [projectId, 0, ''];
  const upper: [string, number, string] = cursor
    ? [projectId, cursor.timestamp, cursor.id] : [projectId, Number.MAX_SAFE_INTEGER, '\uffff'];
  return IDBKeyRange.bound(lower, upper, false, Boolean(cursor));
}

export function pruneProjectHistory(store: IDBObjectStore, projectId: string): void {
  const request = store.index('projectId_timestamp_id').openKeyCursor(projectHistoryRange(projectId), 'prev');
  let skippedRetained = false;
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    if (!skippedRetained) {
      skippedRetained = true;
      cursor.advance(16);
      return;
    }
    store.delete(cursor.primaryKey);
    cursor.continue();
  };
}
