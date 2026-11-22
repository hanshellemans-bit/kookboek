// Pointer-based drag & drop (works for mouse and, via long-press, for touch).
// Drop targets are any elements with a data-date attribute.
// Usage: makeDraggable(el, payload, label); set dnd.onDrop = (date, payload) => ...

export const dnd = { onDrop: null, onStart: null, onEnd: null };

const LONG_PRESS_MS = 350;
let drag = null;             // active drag: { payload, ghost, x, y, over }
let suppressClickUntil = 0;

// A drag must not be followed by the click that would open the link under the pointer.
addEventListener('click', e => {
  if (performance.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); }
}, true);
// On touch, stop the page from scrolling while dragging.
document.addEventListener('touchmove', e => { if (drag) e.preventDefault(); }, { passive: false });

export function makeDraggable(el, payload, label) {
  el.classList.add('draggable');
  el.addEventListener('dragstart', e => e.preventDefault());           // no native link/image drag
  el.addEventListener('contextmenu', e => { if (el._pressing || drag) e.preventDefault(); });

  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 || drag || e.target.closest('button, input, select, textarea')) return;
    const start = { x: e.clientX, y: e.clientY, id: e.pointerId, touch: e.pointerType !== 'mouse' };
    let timer = null;

    const begin = (x, y) => {
      clearTimeout(timer);
      const ghost = document.createElement('div');
      ghost.className = 'ghost';
      ghost.textContent = label;
      document.body.append(ghost);
      document.body.classList.add('dragging');
      drag = { payload, ghost, x, y, over: null };
      dnd.onStart?.();
      navigator.vibrate?.(15);
      move(x, y);
    };

    const finish = dropped => {
      clearTimeout(timer);
      el._pressing = false;
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onUp);
      removeEventListener('keydown', onKey);
      if (!drag) return;
      const { ghost, payload: p, over } = drag;
      ghost.remove();
      document.body.classList.remove('dragging');
      document.querySelectorAll('.over').forEach(n => n.classList.remove('over'));
      drag = null;
      suppressClickUntil = performance.now() + 400;
      if (dropped && over) dnd.onDrop?.(over.dataset.date, p);
      dnd.onEnd?.();
    };

    const onMove = ev => {
      if (ev.pointerId !== start.id) return;
      if (!drag) {
        const dist = Math.hypot(ev.clientX - start.x, ev.clientY - start.y);
        if (start.touch) { if (dist > 10) finish(false); }              // finger moved first: user is scrolling
        else if (dist > 6) begin(ev.clientX, ev.clientY);
        return;
      }
      move(ev.clientX, ev.clientY);
    };
    const onUp = ev => { if (ev.pointerId === start.id) finish(ev.type === 'pointerup'); };
    const onKey = ev => { if (ev.key === 'Escape') finish(false); };

    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
    addEventListener('pointercancel', onUp);
    addEventListener('keydown', onKey);
    if (start.touch) {
      el._pressing = true;
      timer = setTimeout(() => begin(start.x, start.y), LONG_PRESS_MS);
    }
  });
}

function move(x, y) {
  drag.ghost.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
  const over = document.elementFromPoint(x, y)?.closest('[data-date]') ?? null;
  if (over !== drag.over) {
    drag.over?.classList.remove('over');
    over?.classList.add('over');
    drag.over = over;
  }
}
