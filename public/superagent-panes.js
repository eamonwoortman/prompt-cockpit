// Draggable splitters between the Superagent tab's three panes. The left and
// middle widths are the operator's, kept per browser in localStorage; the
// right pane (needs you, Ready to try, router) takes whatever is left, so it
// grows with the window. Until the middle splitter is moved, the middle and
// right panes share the space equally (middle: null). Double-click a splitter
// to put its default back; with focus on one, the arrow keys move it.
const STORAGE_KEY = 'cockpit:superagentPaneWidths';
export const PANE_DEFAULTS = { left: 300, middle: null };
const MIN = { left: 200, middle: 360 };
const MAX_LEFT = 600;
const RIGHT_MIN = 280;
const KEY_STEP = 24;

export function readPaneWidths(storage) {
  let saved = {};
  try {
    saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}') ?? {};
  } catch {
    saved = {};
  }
  const pick = (name) => (Number.isFinite(saved[name]) && saved[name] >= MIN[name] ? saved[name] : PANE_DEFAULTS[name]);
  return { left: Math.min(MAX_LEFT, pick('left')), middle: pick('middle') };
}

function writePaneWidths(storage, widths) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // Storage full or disabled: the widths just last until a reload.
  }
}

export function initPaneResizers(panes, { left, middle }, storage = globalThis.localStorage) {
  const widths = readPaneWidths(storage);
  const apply = () => {
    panes.style.setProperty('--sa-left-w', `${widths.left}px`);
    if (widths.middle === null) panes.style.removeProperty('--sa-middle-w');
    else panes.style.setProperty('--sa-middle-w', `${widths.middle}px`);
  };

  // The most a pane may take now: the right pane keeps RIGHT_MIN.
  function maxFor(name) {
    if (name === 'left') return MAX_LEFT;
    const splitters = [...panes.querySelectorAll('.sa-splitter')].reduce((n, s) => n + s.offsetWidth, 0);
    return Math.max(MIN.middle, panes.clientWidth - left.offsetWidth - splitters - RIGHT_MIN);
  }

  function set(name, px, save) {
    widths[name] = px === null ? null : Math.round(Math.min(maxFor(name), Math.max(MIN[name], px)));
    apply();
    if (save) writePaneWidths(storage, widths);
  }

  function splitter(name, pane, label) {
    const bar = document.createElement('div');
    bar.className = 'sa-splitter';
    bar.setAttribute('role', 'separator');
    bar.setAttribute('aria-orientation', 'vertical');
    bar.setAttribute('aria-label', label);
    bar.tabIndex = 0;
    bar.title = `${label}: drag, or use the arrow keys; double-click resets`;
    bar.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      // Start from the rendered width: the grid may have shrunk the pane.
      const startX = event.clientX;
      const startWidth = pane.getBoundingClientRect().width;
      bar.setPointerCapture(event.pointerId);
      panes.classList.add('sa-resizing');
      const move = (e) => set(name, startWidth + e.clientX - startX, false);
      const end = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', end);
        bar.removeEventListener('pointercancel', end);
        panes.classList.remove('sa-resizing');
        writePaneWidths(storage, widths);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', end);
      bar.addEventListener('pointercancel', end);
    });
    bar.addEventListener('dblclick', () => set(name, PANE_DEFAULTS[name], true));
    bar.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowLeft' ? -KEY_STEP : event.key === 'ArrowRight' ? KEY_STEP : 0;
      if (!step) return;
      event.preventDefault();
      set(name, pane.getBoundingClientRect().width + step, true);
    });
    pane.after(bar);
  }

  apply();
  splitter('left', left, 'Resize the jobs pane');
  splitter('middle', middle, 'Resize the job pane');
}
