/**
 * canvasNodeDataSelector — 为展示订阅投影必要字段，忽略节点几何与无关业务数据。
 */
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import { getCanvasNodeById } from './canvasRenderProjection';

export type CanvasNodeDataView = Pick<Node<BaseNodeData>, 'id' | 'type' | 'data'>;
const EMPTY_CANVAS_DATA_VIEWS: CanvasNodeDataView[] = [];

/** 每个消费者独立持有最近快照；返回值只用于展示，不用于位置计算或写回 Store。 */
export function createCanvasNodeDataSelector(
  fields: readonly (keyof BaseNodeData)[],
  ids?: readonly string[],
) {
  const keys = [...new Set<keyof BaseNodeData>(['type', 'label', ...fields])];
  let previousNodes: readonly Node<BaseNodeData>[] | undefined;
  let result = EMPTY_CANVAS_DATA_VIEWS;
  return (nodes?: readonly Node<BaseNodeData>[]): CanvasNodeDataView[] => {
    // 隐藏候选或空草稿不保留上一张画布的重数据引用。
    if (!nodes || ids?.length === 0) {
      previousNodes = undefined;
      result = EMPTY_CANVAS_DATA_VIEWS;
      return result;
    }
    if (nodes === previousNodes) return result;
    previousNodes = nodes;
    const sources = ids
      ? ids.flatMap((id) => { const node = getCanvasNodeById(nodes, id); return node ? [node] : []; })
      : nodes;
    let changed = result.length !== sources.length;
    const next = sources.map((node, index) => {
      const old = result[index];
      if (old?.id === node.id && old.type === node.type && keys.every((key) => old.data[key] === node.data[key])) return old;
      changed = true;
      return { id: node.id, type: node.type,
        data: Object.fromEntries(keys.map((key) => [key, node.data[key]])) as BaseNodeData };
    });
    if (changed) result = next;
    return result;
  };
}
