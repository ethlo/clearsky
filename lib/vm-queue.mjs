// How many chats' VMs run at once (Settings → Copilot → VMs at the same time, default 1). Each VM
// takes a share of the machine's cores and memory: three chats building at once made all three
// slow. A chat whose VM is up holds a place; another chat's `vm` command waits in line for one,
// first come first served, and says where it is in line.
// - A VM with nothing running in it gives its place to the first in line at once (it's stopped,
//   and starts again, from the snapshot, on its chat's next command).
// - A chat's own commands share its place: a second one never waits behind the first.
// - Stopping a chat or its command takes it out of the line.

export const VM_MAX_DEFAULT = 1;
export function vmMax(env = process.env) {
  const n = Math.floor(Number(String(env.COPILOT_VM_MAX ?? '').trim()));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : VM_MAX_DEFAULT;
}

export class VmQueue {
  // limit: read every time, so a change in Settings applies to the next one in line.
  constructor({ limit = () => vmMax() } = {}) {
    this.limit = limit;
    this.holders = new Map(); // holder → { active, evict }
    this.line = []; // { holder, calls: [{ done, fail }], notify, since }
  }

  // Wait for a place for holder (a chat's VM); resolves at once when it has one. evict stops it
  // (its VM), to give its place to the next in line when nothing runs in it.
  enter(holder, { evict, signal, notify } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    const h = this.holders.get(holder);
    if (h) { h.active++; if (evict) h.evict = evict; return Promise.resolve({ waited: false }); }
    return new Promise((done, fail) => {
      let w = this.line.find((x) => x.holder === holder);
      if (!w) { w = { holder, calls: [], evict, notify, since: Date.now() }; this.line.push(w); }
      if (notify) w.notify = notify;
      if (evict) w.evict = evict;
      const call = { done, fail };
      w.calls.push(call);
      signal?.addEventListener('abort', () => {
        w.calls = w.calls.filter((c) => c !== call);
        if (!w.calls.length) this.line = this.line.filter((x) => x !== w);
        fail(abortError());
        this.pump();
      }, { once: true });
      this.pump();
    });
  }

  // A command of holder's ended. Nothing else runs in it and someone waits: it makes room.
  leave(holder) {
    const h = this.holders.get(holder);
    if (!h) return;
    h.active = Math.max(0, h.active - 1);
    this.pump();
  }

  // holder's VM stopped (idle, closed, moved, crashed): its place goes to the next in line, and
  // its own waiting calls (if any) stop waiting.
  drop(holder, why = 'the VM was stopped') {
    this.holders.delete(holder);
    const w = this.line.find((x) => x.holder === holder);
    if (w) { this.line = this.line.filter((x) => x !== w); for (const c of w.calls) c.fail(new Error(why)); }
    this.pump();
  }

  // Where holder is: null when it isn't waiting, else 1 for first in line.
  position(holder) {
    const i = this.line.findIndex((x) => x.holder === holder);
    return i < 0 ? null : i + 1;
  }

  view(holder) {
    return { limit: this.limit(), running: this.holders.size, waiting: this.line.length, position: holder ? this.position(holder) : null };
  }

  pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      // Free places first, in order.
      while (this.line.length && this.holders.size < this.limit()) this.#grant(this.line.shift());
      // Then idle VMs make room for whoever waits (oldest idle first: the Map keeps start order).
      for (const [holder, h] of [...this.holders]) {
        if (!this.line.length) break;
        if (h.active > 0) continue;
        // evict() stops the VM (which also calls drop()); either way its place is free now.
        this.holders.delete(holder);
        try { h.evict?.(); } catch {}
        while (this.line.length && this.holders.size < this.limit()) this.#grant(this.line.shift());
      }
    } finally { this.pumping = false; }
    for (const [i, w] of this.line.entries()) {
      if (w.told === i + 1) continue;
      w.told = i + 1;
      try { w.notify?.({ position: i + 1, waiting: this.line.length, limit: this.limit() }); } catch {}
    }
  }

  #grant(w) {
    this.holders.set(w.holder, { active: w.calls.length, evict: w.evict });
    for (const c of w.calls) c.done({ waited: true, ms: Date.now() - w.since });
  }
}

function abortError() { const e = new Error('stopped while waiting for a VM'); e.name = 'AbortError'; return e; }
