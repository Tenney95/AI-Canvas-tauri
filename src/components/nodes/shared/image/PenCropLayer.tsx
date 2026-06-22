/**
 * PenCropLayer — 贝塞尔钢笔路径裁剪图层
 *
 * 覆盖在裁剪图像之上的 SVG 图层，提供 PS 风格的钢笔工具：
 *  - 单击放角点；按住拖拽拉出对称曲线控制柄
 *  - 单击首个锚点闭合路径
 *  - 闭合后/创建中均可拖动锚点与控制柄；Alt 拖控制柄断开对称（尖角）
 *  - 双击锚点在「角点 / 平滑」间切换
 *  - Backspace/Delete 删除选中（未闭合时删除最后一个）锚点
 *
 * 锚点坐标保存在「自然图像像素」空间，故缩放/平移/窗口变化都不影响对齐，
 * 导出时直接用于 canvas 路径裁切。
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

export interface Pt {
  x: number;
  y: number;
}
export interface Anchor {
  p: Pt;
  hIn: Pt | null;
  hOut: Pt | null;
  broken?: boolean;
}
export interface PenData {
  anchors: Anchor[];
  closed: boolean;
}
export interface PenCropHandle {
  getData: () => PenData;
  reset: () => void;
}

interface PenCropLayerProps {
  active: boolean;
  /** 自然图像尺寸（像素），用作 SVG viewBox 与坐标空间 */
  naturalWidth: number;
  naturalHeight: number;
  /** 图像 CSS 显示宽度（未含缩放），用于换算屏幕常量尺寸 */
  displayWidth: number;
  /** 当前缩放倍率 */
  scale: number;
  /** 路径是否可用于裁切（已闭合且 ≥3 锚点）变化时回调 */
  onReadyChange: (ready: boolean) => void;
}

/* 屏幕常量尺寸（px），渲染时换算到 viewBox 单位 */
const ANCHOR_HALF_PX = 4.5;
const HANDLE_R_PX = 4;
const HIT_PX = 11;
const STROKE_PX = 1.4;

const mirror = (p: Pt, h: Pt): Pt => ({ x: 2 * p.x - h.x, y: 2 * p.y - h.y });
const add = (a: Pt, d: Pt): Pt => ({ x: a.x + d.x, y: a.y + d.y });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const clone = (a: Anchor): Anchor => ({
  p: { ...a.p },
  hIn: a.hIn ? { ...a.hIn } : null,
  hOut: a.hOut ? { ...a.hOut } : null,
  broken: a.broken,
});

interface Drag {
  kind: 'create' | 'anchor' | 'hin' | 'hout' | 'close';
  index: number;
  alt: boolean;
  moved: boolean;
  grab: Pt;
  snap: Anchor;
}

/** 由锚点+闭合状态构建 SVG path d 字符串（缺省控制柄 → 退化为直线段）*/
function buildPathD(anchors: Anchor[], closed: boolean): string {
  if (anchors.length === 0) return '';
  const a0 = anchors[0];
  let d = `M ${a0.p.x} ${a0.p.y}`;
  const segs = closed ? anchors.length : anchors.length - 1;
  for (let i = 0; i < segs; i++) {
    const cur = anchors[i];
    const nxt = anchors[(i + 1) % anchors.length];
    const c1 = cur.hOut ?? cur.p;
    const c2 = nxt.hIn ?? nxt.p;
    d += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${nxt.p.x} ${nxt.p.y}`;
  }
  if (closed) d += ' Z';
  return d;
}

const PenCropLayer = forwardRef<PenCropHandle, PenCropLayerProps>(function PenCropLayer(
  { active, naturalWidth, naturalHeight, displayWidth, scale, onReadyChange },
  ref,
) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [closed, setClosed] = useState(false);
  const [selected, setSelected] = useState(-1);
  const dragRef = useRef<Drag | null>(null);

  // viewBox 单位 / 屏幕 px 的换算系数（屏上恒定尺寸用）
  const k = naturalWidth / Math.max(displayWidth * scale, 1);
  const anchorHalf = ANCHOR_HALF_PX * k;
  const handleR = HANDLE_R_PX * k;
  const hit = HIT_PX * k;
  const stroke = STROKE_PX * k;

  useImperativeHandle(
    ref,
    () => ({
      getData: () => ({ anchors, closed }),
      reset: () => {
        setAnchors([]);
        setClosed(false);
        setSelected(-1);
        dragRef.current = null;
      },
    }),
    [anchors, closed],
  );

  useEffect(() => {
    onReadyChange(closed && anchors.length >= 3);
  }, [closed, anchors.length, onReadyChange]);

  /* 屏幕坐标 → 自然图像坐标 */
  const toLocal = useCallback(
    (e: { clientX: number; clientY: number }): Pt => {
      const rect = svgRef.current!.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / rect.width) * naturalWidth,
        y: ((e.clientY - rect.top) / rect.height) * naturalHeight,
      };
    },
    [naturalWidth, naturalHeight],
  );

  /* 命中测试：返回最优先的可拖拽目标 */
  const hitTest = useCallback(
    (pt: Pt): Drag | null => {
      // 控制柄优先（仅选中锚点显示控制柄）
      if (selected >= 0 && selected < anchors.length) {
        const a = anchors[selected];
        if (a.hOut && dist(pt, a.hOut) <= hit)
          return { kind: 'hout', index: selected, alt: false, moved: false, grab: pt, snap: clone(a) };
        if (a.hIn && dist(pt, a.hIn) <= hit)
          return { kind: 'hin', index: selected, alt: false, moved: false, grab: pt, snap: clone(a) };
      }
      // 锚点本体
      for (let i = 0; i < anchors.length; i++) {
        if (dist(pt, anchors[i].p) <= hit)
          return { kind: 'anchor', index: i, alt: false, moved: false, grab: pt, snap: clone(anchors[i]) };
      }
      return null;
    },
    [anchors, selected, hit],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (!active || e.button !== 0) return;
      e.stopPropagation();
      const pt = toLocal(e);
      svgRef.current!.setPointerCapture(e.pointerId);

      // 未闭合 + 点到首锚点 → 闭合
      if (!closed && anchors.length >= 2 && dist(pt, anchors[0].p) <= hit) {
        dragRef.current = { kind: 'close', index: 0, alt: false, moved: false, grab: pt, snap: clone(anchors[0]) };
        return;
      }

      // 命中已有锚点/控制柄 → 编辑
      const hitDrag = hitTest(pt);
      if (hitDrag) {
        hitDrag.alt = e.altKey;
        dragRef.current = hitDrag;
        setSelected(hitDrag.index);
        return;
      }

      // 闭合后点空白 → 取消选中
      if (closed) {
        setSelected(-1);
        return;
      }

      // 否则新增锚点（按下=角点，拖拽=平滑曲线柄）
      const newAnchor: Anchor = { p: pt, hIn: null, hOut: null };
      setAnchors((prev) => [...prev, newAnchor]);
      const newIndex = anchors.length;
      setSelected(newIndex);
      dragRef.current = { kind: 'create', index: newIndex, alt: e.altKey, moved: false, grab: pt, snap: clone(newAnchor) };
    },
    [active, closed, anchors, hit, toLocal, hitTest],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const pt = toLocal(e);
      drag.moved = drag.moved || dist(pt, drag.grab) > hit * 0.4;

      setAnchors((prev) => {
        const next = prev.slice();
        const a = clone(next[drag.index] ?? drag.snap);
        switch (drag.kind) {
          case 'create': {
            // 拖拽拉出对称控制柄
            a.p = { ...drag.snap.p };
            a.hOut = { ...pt };
            a.hIn = mirror(a.p, pt);
            break;
          }
          case 'anchor': {
            const d = { x: pt.x - drag.grab.x, y: pt.y - drag.grab.y };
            a.p = add(drag.snap.p, d);
            a.hIn = drag.snap.hIn ? add(drag.snap.hIn, d) : null;
            a.hOut = drag.snap.hOut ? add(drag.snap.hOut, d) : null;
            break;
          }
          case 'hout': {
            a.hOut = { ...pt };
            if (drag.alt) a.broken = true;
            if (!a.broken) a.hIn = mirror(a.p, pt);
            break;
          }
          case 'hin': {
            a.hIn = { ...pt };
            if (drag.alt) a.broken = true;
            if (!a.broken) a.hOut = mirror(a.p, pt);
            break;
          }
          case 'close':
            return prev;
        }
        next[drag.index] = a;
        return next;
      });
    },
    [hit, toLocal],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      svgRef.current?.releasePointerCapture(e.pointerId);
      if (drag.kind === 'close') setClosed(true);
      dragRef.current = null;
    },
    [],
  );

  /* 双击锚点：角点 ↔ 平滑 切换 */
  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      if (!active) return;
      const pt = toLocal(e);
      const i = anchors.findIndex((a) => dist(pt, a.p) <= hit);
      if (i < 0) return;
      e.stopPropagation();
      setAnchors((prev) => {
        const next = prev.slice();
        const a = clone(next[i]);
        if (a.hIn || a.hOut) {
          a.hIn = null;
          a.hOut = null;
          a.broken = false;
        } else {
          const n = next.length;
          const prevP = next[(i - 1 + n) % n].p;
          const nextP = next[(i + 1) % n].p;
          const dir = { x: nextP.x - prevP.x, y: nextP.y - prevP.y };
          const len = Math.hypot(dir.x, dir.y) || 1;
          const L = Math.min(dist(a.p, nextP), dist(a.p, prevP)) / 3 || len / 3;
          const u = { x: (dir.x / len) * L, y: (dir.y / len) * L };
          a.hOut = add(a.p, u);
          a.hIn = { x: a.p.x - u.x, y: a.p.y - u.y };
        }
        next[i] = a;
        return next;
      });
    },
    [active, anchors, hit, toLocal],
  );

  /* 删除锚点 */
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      setAnchors((prev) => {
        if (prev.length === 0) return prev;
        const idx = !closed ? prev.length - 1 : selected;
        if (idx < 0) return prev;
        const next = prev.filter((_, i) => i !== idx);
        if (next.length < 3) setClosed(false);
        return next;
      });
      setSelected(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, closed, selected]);

  if (naturalWidth <= 0 || naturalHeight <= 0) return null;

  const pathD = buildPathD(anchors, closed);
  const selAnchor = selected >= 0 ? anchors[selected] : null;

  return (
    <svg
      ref={svgRef}
      className="crop-pen-svg"
      viewBox={`0 0 ${naturalWidth} ${naturalHeight}`}
      preserveAspectRatio="none"
      style={{ pointerEvents: active ? 'auto' : 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {/* 路径填充 + 描边 */}
      {pathD && (
        <>
          <path d={pathD} className="crop-pen-fill" fillRule="evenodd" />
          <path d={pathD} className="crop-pen-stroke" fill="none" strokeWidth={stroke} />
        </>
      )}

      {/* 选中锚点的控制柄 */}
      {selAnchor && (
        <g className="crop-pen-handles">
          {selAnchor.hIn && (
            <>
              <line x1={selAnchor.p.x} y1={selAnchor.p.y} x2={selAnchor.hIn.x} y2={selAnchor.hIn.y} strokeWidth={stroke} />
              <circle cx={selAnchor.hIn.x} cy={selAnchor.hIn.y} r={handleR} />
            </>
          )}
          {selAnchor.hOut && (
            <>
              <line x1={selAnchor.p.x} y1={selAnchor.p.y} x2={selAnchor.hOut.x} y2={selAnchor.hOut.y} strokeWidth={stroke} />
              <circle cx={selAnchor.hOut.x} cy={selAnchor.hOut.y} r={handleR} />
            </>
          )}
        </g>
      )}

      {/* 锚点方块 */}
      {anchors.map((a, i) => (
        <rect
          key={i}
          className={`crop-pen-anchor${i === selected ? ' selected' : ''}${i === 0 && !closed ? ' first' : ''}`}
          x={a.p.x - anchorHalf}
          y={a.p.y - anchorHalf}
          width={anchorHalf * 2}
          height={anchorHalf * 2}
          strokeWidth={stroke}
        />
      ))}
    </svg>
  );
});

export default PenCropLayer;
