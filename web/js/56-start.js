// Clearsky page: the start box. Starting Copilot on a PR or ticket (its next step, a skill from
// the ✦ menu, or a New task card) first asks two things: anything to add to the ticket, and
// which skill to run (one is picked for you, "None" just sends your words). Enter starts it
// with what's there, so a quick start is still one key; Shift+click on the button skips the box.

// What you get back: { skill, extra } when you start, null when you cancel.
async function askStart({ label = '', title = '', skill = '', handoff = '', placeholder = '' } = {}) {
  if (!chat.info) await loadCopilotInfo();
  $('#start-dlg')?.remove(); // a fresh box each time, with its own listeners
  const dlg = document.createElement('dialog');
  dlg.id = 'start-dlg';
  dlg.className = 'start-dlg';
  document.body.append(dlg);
  const skills = chat.info?.skills || [];
  const pick = skills.some((s) => s.name === skill) ? skill : '';
  const desc = (n) => skills.find((s) => s.name === n)?.description || 'Only the ticket and your words, no skill';
  dlg.innerHTML = `<form method="dialog">
    <div class="sd-h">${icon('spark', 15)}<span>Start Copilot on ${esc(label || 'this')}</span></div>
    ${title && title !== label ? `<div class="sd-title">${esc(title)}</div>` : ''}
    ${handoff ? `<div class="sd-note">The hand-off from the other chat goes in too.</div>` : ''}
    <label class="sd-l" for="sd-text">Anything to add <span>(optional)</span></label>
    <textarea id="sd-text" rows="4" placeholder="${esc(placeholder || 'e.g. Only the backend part. Keep the old endpoint for now. Ask before changing the schema.')}"></textarea>
    <label class="sd-l" for="sd-skill">Skill</label>
    <select id="sd-skill">
      <option value="">None</option>
      ${skills.map((s) => `<option value="${esc(s.name)}"${s.name === pick ? ' selected' : ''}>/${esc(s.name)}</option>`).join('')}
    </select>
    <div class="sd-desc" id="sd-desc">${esc(desc(pick))}</div>
    <div class="sd-b">
      <span class="sd-k">Enter starts · Shift+Enter for a new line · Esc cancels</span>
      <button type="button" value="cancel" data-sd="cancel">Cancel</button>
      <button type="submit" class="r-save" data-sd="start">Start</button>
    </div>
  </form>`;
  const text = dlg.querySelector('#sd-text'), sel = dlg.querySelector('#sd-skill');
  sel.addEventListener('change', () => { dlg.querySelector('#sd-desc').textContent = desc(sel.value); });
  return new Promise((resolve) => {
    let out = null;
    const start = () => { out = { skill: sel.value, extra: text.value.trim() }; dlg.close(); };
    dlg.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); start(); });
    dlg.querySelector('[data-sd="cancel"]').addEventListener('click', () => dlg.close());
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); start(); }
    });
    dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); dlg.close(); } });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // a click outside the box
    dlg.addEventListener('close', () => { resolve(out); dlg.remove(); }, { once: true });
    dlg.showModal();
    text.focus();
  });
}

// The first message of a chat started this way: the skill, then your words.
const startMessage = ({ skill, extra }, fallback = 'What is the next step on this?') =>
  [skill && `/${skill}`, extra].filter(Boolean).join(' ') || fallback;
