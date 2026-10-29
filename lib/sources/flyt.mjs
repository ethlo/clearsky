// School: what Visma Flyt Skole (Min Skole / Flyt Foresatt) has for your children. Log in once
// with BankID from Settings; the login is kept in the GNOME keyring.

import { collectFlyt, waiting, inbox, portalUrl, defaultStore, readFlyt, flytFile } from '../flyt.mjs';
import { login } from '../flyt-login.mjs';

const WHAT = { message: 'Message', notice: 'Notice', announcement: 'Announcement', form: 'Form to answer', consent: 'Consent to answer' };

export default {
  name: 'flyt',
  label: 'Visma Flyt Skole',
  area: 'personal',
  settings: {
    FLYT_SCHOOL_KEY: { label: 'School portal key', hint: 'The last part of https://foresatt.visma.no/<key>. Filled in for you when you log in, if the portal tells us.', secret: false },
  },
  login: {
    label: 'Log in with BankID',
    async status() {
      const s = await (await defaultStore()).get();
      if (!s) return { loggedIn: false, detail: 'Opens a browser window for ID-porten (BankID or MinID).' };
      if (s.expiredAt) return { loggedIn: false, detail: 'Visma ended the login. Log in again.' };
      return { loggedIn: true, detail: `Since ${new Date(s.loggedInAt).toLocaleString('nb-NO', { dateStyle: 'medium', timeStyle: 'short' })}` };
    },
    async start(env) {
      const { customerKey } = await login({ schoolKey: env.FLYT_SCHOOL_KEY });
      return { settings: { FLYT_SCHOOL_KEY: env.FLYT_SCHOOL_KEY || customerKey } };
    },
  },
  enabled: (env) => !!env.FLYT_SCHOOL_KEY,
  // An inbox: everything from school, newest first, by School or child. The count is what's unread.
  panel: { title: 'School', zone: 'needs', view: 'table' },

  async fetch(ctx) {
    const data = await collectFlyt();
    return { ...data, customerKey: data.customerKey || ctx.env.FLYT_SCHOOL_KEY };
  },

  items: (d) => inbox(d).map((m) => ({
    key: m.key, stamp: m.stamp, url: portalUrl(d.customerKey), detail: true,
    title: m.title, quote: m.body, at: m.at, from: m.from || 'The school', group: m.group, files: m.files, unread: m.unread,
    badge: WHAT[m.what], tone: m.unread && (m.what === 'form' || m.what === 'consent') ? 'amber' : undefined,
    meta: m.deadline ? `Answer by ${m.deadline.slice(0, 10)}` : undefined,
  })),

  // The whole message, notice or form, and its files, read inside Clearsky.
  detail: (key, ctx, data) => readFlyt(key, data),
  attachment: (key, id, ctx, data) => flytFile(key, id, data),

  attention: (d) => waiting(d).map((w) => ({
    key: w.key, stamp: w.stamp, at: w.at, url: portalUrl(d.customerKey),
    title: `${w.child}: ${w.title || WHAT[w.what]}`, body: w.body || WHAT[w.what],
  })),

  // Deadlines on forms you haven't answered, as reminders that don't block time.
  events: (d) => waiting(d).filter((w) => w.deadline).map((w) => ({
    uid: w.key, title: `${w.child}: answer "${w.title}"`, start: w.deadline, end: w.deadline, allDay: false, fyi: true,
  })),
};
