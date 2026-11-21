/** 复用已有主键游标；事务、索引范围和错误处理仍由调用方负责。 */
export function deleteKeyCursorEntries(store: IDBObjectStore, request: IDBRequest<IDBCursor | null>): void {
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    store.delete(cursor.primaryKey);
    cursor.continue();
  };
}
