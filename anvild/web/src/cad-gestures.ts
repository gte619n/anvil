// ── cad-gestures.ts — reusable pinch-zoom + pan for a 2D element (spec Phase 8 + ECAD) ──────────
// Pure DOM, no three.js. Attaches pointer + wheel handlers to `el` and drives a CSS
// `transform: translate(tx, ty) scale(s)`. Reused by the image lightbox and the ECAD SVG viewer.
//
// Design notes:
//  • We use the Pointer Events API (pointerdown/move/up) so a single code path covers mouse, touch
//    and pen. Two concurrent touch pointers → pinch (scale about the gesture midpoint). One pointer
//    dragging → pan. The mouse wheel also zooms (about the cursor), matching the usual map/figure feel.
//  • The transform is applied to `el` itself. The caller is responsible for giving `el` (or an
//    ancestor) `overflow: hidden` if it wants the panned content clipped; we set `touch-action: none`
//    on `el` so the browser doesn't steal the gesture for native scrolling/zoom.
//  • Zooming about a focal point keeps that screen point stationary: we convert the focal point into
//    the element's pre-transform local space, change scale, then re-solve the translation.

/** Options for `enablePinchPan`. */
export interface PinchPanOpts {
  /** Upper bound on the zoom factor (default 8). */
  maxScale?: number;
  /** Lower bound on the zoom factor (default 0.2). */
  minScale?: number;
}

/**
 * Make `el` pinch-zoomable and pannable. Returns a cleanup function that removes every listener and
 * clears the inline transform, so the caller can detach the behaviour on teardown.
 */
export function enablePinchPan(el: HTMLElement, opts: PinchPanOpts = {}): () => void {
  const maxScale = opts.maxScale ?? 8;
  const minScale = opts.minScale ?? 0.2;

  // Current transform state. `tx`/`ty` are in CSS pixels (post-scale translation), `scale` is the factor.
  let scale = 1;
  let tx = 0;
  let ty = 0;

  // Live pointers, keyed by pointerId, each storing the latest client-space position. Using a Map
  // keeps multi-touch bookkeeping simple and order-independent.
  const pointers = new Map<number, { x: number; y: number }>();

  // Pinch bookkeeping: distance + midpoint captured when the second finger lands, refreshed each move.
  let pinchStartDist = 0;
  let pinchStartScale = 1;

  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

  const apply = (): void => {
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  // The element's own origin in client space, so we can map a client point into element-local coords.
  const originClient = (): { ox: number; oy: number } => {
    const r = el.getBoundingClientRect();
    // The rect already includes our transform; back out translate+scale to recover the untransformed
    // top-left. (left = ox*scale + tx + untransformedLeft) — but it's simpler to zoom about the rect
    // directly: we keep focal math in client space and adjust tx/ty, which is what `zoomAbout` does.
    return { ox: r.left, oy: r.top };
  };

  /** Zoom to `next` scale while keeping the client-space point (cx, cy) visually fixed. */
  const zoomAbout = (next: number, cx: number, cy: number): void => {
    const clamped = clamp(next, minScale, maxScale);
    if (clamped === scale) return;
    const { ox, oy } = originClient();
    // Position of the focal point relative to the element's current (already-transformed) top-left.
    const relX = cx - ox;
    const relY = cy - oy;
    const ratio = clamped / scale;
    // Shifting the translate so the focal point stays put: new_rel = ratio * old_rel, so we move the
    // element by the difference.
    tx += relX - relX * ratio;
    ty += relY - relY * ratio;
    scale = clamped;
    apply();
  };

  const midpoint = (): { x: number; y: number } => {
    const pts = [...pointers.values()];
    const a = pts[0]!;
    const b = pts[1]!;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const distance = (): number => {
    const pts = [...pointers.values()];
    const a = pts[0]!;
    const b = pts[1]!;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onPointerDown = (e: PointerEvent): void => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Capture so we keep getting moves even if the pointer leaves the element bounds mid-drag.
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture can throw if the pointer is already gone; harmless.
    }
    if (pointers.size === 2) {
      pinchStartDist = distance();
      pinchStartScale = scale;
    }
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent): void => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const nx = e.clientX;
    const ny = e.clientY;

    if (pointers.size >= 2) {
      // Pinch: scale about the midpoint of the two live fingers. Update this pointer first so the
      // distance/midpoint reflect the new position.
      pointers.set(e.pointerId, { x: nx, y: ny });
      const dist = distance();
      if (pinchStartDist > 0) {
        const mid = midpoint();
        zoomAbout(pinchStartScale * (dist / pinchStartDist), mid.x, mid.y);
      }
    } else {
      // Single-pointer drag: pan by the delta.
      tx += nx - prev.x;
      ty += ny - prev.y;
      pointers.set(e.pointerId, { x: nx, y: ny });
      apply();
    }
    e.preventDefault();
  };

  const endPointer = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    // Dropping from two fingers to one: re-seed the pinch baseline so a lingering finger doesn't jump.
    if (pointers.size === 2) {
      pinchStartDist = distance();
      pinchStartScale = scale;
    }
  };

  const onWheel = (e: WheelEvent): void => {
    // Trackpad/mouse wheel zoom about the cursor. Negative deltaY = zoom in. The exponential step
    // feels smoother than a linear one across both coarse wheels and fine trackpads.
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAbout(scale * factor, e.clientX, e.clientY);
  };

  // `touch-action: none` disables the browser's own pan/zoom so our handlers own the gesture.
  const prevTouchAction = el.style.touchAction;
  el.style.touchAction = "none";

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", endPointer);
  el.addEventListener("pointercancel", endPointer);
  el.addEventListener("wheel", onWheel, { passive: false });

  apply();

  return () => {
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", endPointer);
    el.removeEventListener("pointercancel", endPointer);
    el.removeEventListener("wheel", onWheel);
    el.style.touchAction = prevTouchAction;
    el.style.transform = "";
    pointers.clear();
  };
}
