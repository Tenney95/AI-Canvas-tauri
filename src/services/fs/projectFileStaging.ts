import { mediaFileAllocationKey } from '../indexedDb/mediaRelocations';

// 同一进程里尚未交给画布的文件不能成为另一笔导入或去重保存的原件。
const owners = new Map<string, ProjectFileStaging>();

export function canReuseProjectFile(path: string, staging?: ProjectFileStaging): boolean {
  const owner = owners.get(mediaFileAllocationKey(path));
  return !owner || owner === staging;
}

/** 只登记独占创建成功的文件。回滚先返回时，仍在进行的写入自行补办回收。 */
export class ProjectFileStaging {
  private readonly created = new Set<string>();
  private readonly recycle: (path: string) => Promise<void>;
  private discarded = false;

  constructor(recycle: (path: string) => Promise<void>) {
    this.recycle = recycle;
  }

  async write(path: string, writeNew: (markCreated: () => void) => Promise<unknown>): Promise<void> {
    const key = mediaFileAllocationKey(path);
    if (this.discarded || owners.has(key)) throw new Error('素材暂存已失效，请重新导入');
    owners.set(key, this);
    let created = false;
    try { await writeNew(() => { created = true; }); }
    catch (error) {
      if (created) await this.recycleFile(path);
      else owners.delete(key);
      throw error;
    }
    if (this.discarded) await this.recycleFile(path);
    else this.created.add(path);
  }

  commit(): void {
    for (const path of this.created) owners.delete(mediaFileAllocationKey(path));
    this.created.clear();
  }

  async discard(): Promise<void> {
    this.discarded = true;
    for (const path of this.created) await this.recycleFile(path);
    this.created.clear();
  }

  private async recycleFile(path: string): Promise<void> {
    try { await this.recycle(path); }
    catch { console.warn('[资源导入] 未能确认回收，文件留待存储体检'); }
    finally { owners.delete(mediaFileAllocationKey(path)); }
  }
}
