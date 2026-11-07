/** 文件副作用前的低频归档 journal 与最终提交共用耐久事务选项。 */
export function projectTransferWriteTransaction(db: IDBDatabase, stores: string | string[]): IDBTransaction {
  try { return db.transaction(stores, 'readwrite', { durability: 'strict' }); }
  catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'NotSupportedError')) throw error;
    return db.transaction(stores, 'readwrite');
  }
}
