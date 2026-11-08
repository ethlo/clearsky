// Column widths you set by dragging an edge: the menu's, and the chat's side pane. They are kept
// per device. Double-click an edge for its usual width; with an edge focused, ← and → move it.
const COLS_W_KEY = 'clearsky.colw';
const COLW = {
  side: { v: '--side-w', def: 236, min: 224, max: () => 420, sign: 1 },
  cp: { v: '--cp-w', def: 300, min: 240, max: () => Math.max(240, Math.min(760, ($('.cpw')?.clientWidth || 1200) - 420)), sign: -1 },
};
let colW = {};
try { colW = JSON.parse(localStorage.getItem(COLS_W_KEY) || '{}') || {}; } catch {}
function setColW(k, px, save = true) {
  const c = COLW[k];
  if (px == null) delete colW[k];
  else colW[k] = Math.round(Math.min(c.max(), Math.max(c.min, px)));
  const w = colW[k] ?? c.def;
  document.documentElement.style.setProperty(c.v, `${w}px`);
  const g = document.querySelector(`.col-grip[data-col="${k}"]`);
  if (g) { g.setAttribute('aria-valuenow', String(w)); g.setAttribute('aria-valuemin', String(c.min)); g.setAttribute('aria-valuemax', String(c.max())); }
  if (save) try { localStorage.setItem(COLS_W_KEY, JSON.stringify(colW)); } catch {}
}
for (const k of Object.keys(COLW)) setColW(k, colW[k], false);

for (const g of document.querySelectorAll('.col-grip')) {
  const k = g.dataset.col, c = COLW[k];
  g.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = colW[k] ?? c.def;
    g.classList.add('drag'); document.body.classList.add('col-drag');
    const move = (ev) => setColW(k, w0 + c.sign * (ev.clientX - x0), false);
    const up = () => {
      g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
      g.classList.remove('drag'); document.body.classList.remove('col-drag');
      setColW(k, colW[k]);
    };
    g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  });
  g.addEventListener('dblclick', () => setColW(k, null));
  g.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: -16, ArrowRight: 16 }[e.key];
    if (d) { e.preventDefault(); setColW(k, (colW[k] ?? c.def) + c.sign * d); }
    else if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); setColW(k, null); }
  });
}
// A smaller window can make a saved side pane too wide for the chat beside it.
window.addEventListener('resize', () => { if (colW.cp != null) setColW('cp', colW.cp, false); });
