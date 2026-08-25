// Shared drag-to-resize behavior for a right-docked panel with a
// left-edge handle. Factored out of detail-pane.js after session-list-pane.js
// grew a second, near-identical copy of the same drag math (mousedown on the
// handle, clamp between minWidth and 70% of the viewport, persist once per
// drag) - two panels wanting the exact same behavior is a "shared function,"
// not a "pattern to repeat."
//
// Deliberately narrow: only the drag math + persistence. Callers that need
// more (detail-pane.js's --detail-pane-offset var, syncOffset on every
// resize/enable, a ResizeObserver) still wire that themselves around this -
// this only ever touches `panel.style.width`.
export function initResizablePanel({ panel, handle, minWidthPx, initialWidth, onWidthChange, isNarrowLayout }) {
  if (initialWidth != null && !isNarrowLayout?.()) {
    panel.style.width = `${Math.max(initialWidth, minWidthPx)}px`;
  }
  if (!handle) return;

  let dragStartX = null;
  let dragStartWidth = null;

  handle.addEventListener('mousedown', (event) => {
    if (isNarrowLayout?.()) return; // handle is visually still there but inert in a stacked layout
    event.preventDefault(); // don't let the drag start a text selection
    dragStartX = event.clientX;
    dragStartWidth = panel.getBoundingClientRect().width;
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  });

  function onDragMove(event) {
    const maxPx = window.innerWidth * 0.7; // leaves the main content at least 30% of the viewport
    // Dragging left (clientX decreases) grows the box - the panel is
    // right-docked, so this is inverted relative to a normal left-to-right resize.
    const target = Math.min(Math.max(dragStartWidth + (dragStartX - event.clientX), minWidthPx), maxPx);
    panel.style.width = `${target}px`;
  }

  function onDragEnd() {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    // Persisted once per drag, not per mousemove - onWidthChange is a
    // patchSettings() call, cheap but no reason to hammer localStorage
    // dozens of times a second while dragging.
    onWidthChange?.(Math.round(panel.getBoundingClientRect().width));
  }
}
