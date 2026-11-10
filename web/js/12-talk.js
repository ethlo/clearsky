// Clearsky page: talk instead of typing. Click 🎤, speak, click again to stop; the browser's own
// speech recognition writes what you say into the box (Chrome sends the audio to Google to turn
// it into text). Nothing is sent anywhere else until you press Send or Save.
// The chat box has its own 🎤 in its bar; any other <textarea data-talk> gets one in its corner,
// also when it's added later. The settings page loads this file too.

const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
const MIC_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.25"/></svg>';
let talking = null; // { rec, btn, box }: one box at a time

// Start talking into `box`, or stop when it's already listening. onError gets a short reason.
function talkInto(box, btn, onError = () => {}) {
  const was = talking;
  if (was) { was.rec.stop(); if (was.box === box) return; }
  const before = box.value ? `${box.value.replace(/\s*$/, '')} ` : '';
  const rec = new Speech();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = true;
  rec.onresult = (e) => {
    if (!box.isConnected) { rec.stop(); return; } // its box closed while you talked
    box.value = before + [...e.results].map((r) => r[0].transcript).join('').trim();
    box.dispatchEvent(new Event('input', { bubbles: true }));
  };
  rec.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') onError(e.error === 'not-allowed' ? 'the browser blocked the microphone' : e.error); };
  rec.onend = () => {
    if (talking?.rec === rec) talking = null;
    btn.classList.remove('on'); btn.setAttribute('aria-pressed', 'false');
    if (box.isConnected) box.focus();
  };
  talking = { rec, btn, box };
  rec.start();
  btn.classList.add('on'); btn.setAttribute('aria-pressed', 'true');
}

// A 🎤 in the corner of a <textarea data-talk>.
function addMic(box) {
  if (!Speech || box.dataset.talkOn) return;
  box.dataset.talkOn = '1';
  const focused = document.activeElement === box;
  const wrap = document.createElement('span');
  wrap.className = 'talk-wrap';
  box.replaceWith(wrap);
  wrap.append(box);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'talk-mic';
  btn.title = 'Talk: click, speak, click again to stop';
  btn.setAttribute('aria-label', 'Talk');
  btn.setAttribute('aria-pressed', 'false');
  btn.innerHTML = MIC_SVG;
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the box focused
  btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    talkInto(box, btn, (why) => { btn.title = `Talk: ${why}`; btn.classList.add('err'); });
  });
  wrap.append(btn);
  if (focused) box.focus();
}
if (Speech) {
  const scan = (root) => root.querySelectorAll?.('textarea[data-talk]').forEach(addMic);
  scan(document);
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches('textarea[data-talk]')) addMic(n); else scan(n); }
  }).observe(document.documentElement, { childList: true, subtree: true });
}
