/** v2 交换协议只扩展版本化历史；旧 v1 修订原文与摘要保持原合同。 */
import type { ProjectExchangeRevision, ProjectExchangeRevisionHeader, ProjectExchangeSnapshot } from './projectExchange';
import type { ProjectExchangeRevisionV2, ProjectExchangeRevisionHeaderV2 } from './projectArchiveV4';

export type AnyProjectExchangeRevision = ProjectExchangeRevision | ProjectExchangeRevisionV2;
export type AnyProjectExchangeHeader = ProjectExchangeRevisionHeader | ProjectExchangeRevisionHeaderV2;
export type AnyProjectExchangeSnapshot = ProjectExchangeSnapshot | ProjectExchangeRevisionV2['snapshot'];
export type ProjectExchangeBaseResultV2 =
  | { status: 'found'; revision: AnyProjectExchangeRevision }
  | { status: 'unrelated' | 'incomplete' | 'ambiguous' | 'missingSnapshot' };
