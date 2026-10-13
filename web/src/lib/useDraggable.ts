// Lets a floating panel be dragged by a handle (mouse or touch), kept inside
// the window, and remembered in this browser. Without a saved position the
// panel stays where its CSS puts it; double-clicking the handle goes back there.
import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';

type Pos = { x: number; y: number };
const MARGIN = 8;

function load(key: string): Pos | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? v : null;
  } catch {
    return null;
  }
}

function save(key: string, pos: Pos | null) {
  try {
    if (pos) localStorage.setItem(key, JSON.stringify(pos));
    else localStorage.removeItem(key);
  } catch {
    /* private mode - fine, it just isn't remembered */
  }
}

/** Keeps a box of this size fully inside the window. */
export function clampToWindow(p: Pos, width: number, height: number): Pos {
  const maxX = Math.max(MARGIN, window.innerWidth - width - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - height - MARGIN);
  return { x: Math.min(Math.max(p.x, MARGIN), maxX), y: Math.min(Math.max(p.y, MARGIN), maxY) };
}

export function useDraggable<T extends HTMLElement>(storageKey: string) {
  // The element itself (not a ref object), so the fit-in-window check also
  // runs when the panel appears with a saved position.
  const [el, attach] = useState<T | null>(null);
  const [pos, setPos] = useState<Pos | null>(() => load(storageKey));
  const [drag, setDrag] = useState<{ startX: number; startY: number; from: Pos } | null>(null);

  // Stay inside the window when it shrinks or the panel grows (keypad opens).
  useEffect(() => {
    if (!el || !pos) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      setPos((p) => {
        if (!p) return p;
        const c = clampToWindow(p, r.width, r.height);
        return c.x === p.x && c.y === p.y ? p : c;
      });
    };
    fit();
    window.addEventListener('resize', fit);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(el);
    return () => {
      window.removeEventListener('resize', fit);
      ro?.disconnect();
    };
  }, [el, pos]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      // Buttons inside the handle keep working; only the bar itself drags.
      if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setDrag({ startX: e.clientX, startY: e.clientY, from: { x: r.left, y: r.top } });
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.preventDefault(); // no text selection while dragging
    },
    [el],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag;
      if (!d || !el) return;
      const r = el.getBoundingClientRect();
      setPos(
        clampToWindow({ x: d.from.x + e.clientX - d.startX, y: d.from.y + e.clientY - d.startY }, r.width, r.height),
      );
    },
    [el, drag],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!drag) return;
      setDrag(null);
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      setPos((p) => {
        save(storageKey, p);
        return p;
      });
    },
    [storageKey, drag],
  );

  const reset = useCallback(() => {
    setPos(null);
    save(storageKey, null);
  }, [storageKey]);

  return {
    /** Pass as the panel's `ref`. */
    attach,
    moved: pos !== null,
    /** Inline position once moved (overrides the CSS corner). */
    style: pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined,
    handleProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick: reset },
    reset,
  };
}
