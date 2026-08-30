export interface CropOperation {
  id: number;
  isCurrent: () => boolean;
  complete: () => void;
  cancel: () => void;
}

type CropOperationScope = string | object;

let nextOperationId = 0;
const latestOperationByScope = new Map<CropOperationScope, number>();

/** 同一节点已有编码/落盘任务时拒绝再次发起，避免异步结果乱序覆盖。 */
export function beginCropOperation(scope: CropOperationScope): CropOperation | null {
  if (latestOperationByScope.has(scope)) return null;
  const id = ++nextOperationId;
  latestOperationByScope.set(scope, id);
  const isCurrent = () => latestOperationByScope.get(scope) === id;
  const release = () => {
    if (isCurrent()) latestOperationByScope.delete(scope);
  };
  return { id, isCurrent, complete: release, cancel: release };
}
