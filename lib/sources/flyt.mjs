// School: what Visma Flyt Skole (Min Skole / Flyt Foresatt) has for your children. Log in once
// with BankID from Settings; the login is kept in the GNOME keyring.

import { collectFlyt, waiting, inbox, portalUrl, defaultStore, readFlyt, flytFile } from '../flyt.mjs';
import { login } from '../flyt-login.mjs';
import { schoolEvents, CACHE } from '../school-events.mjs';

const WHAT = { message: 'Message', notice: 'Notice', announcement: 'Announcement', form: 'Form to answer', consent: 'Consent to answer' };

export default {
  name: 'flyt',
  label: 'Visma Flyt Skole',
  area: 'personal',
  settings: {
    FLYT_SCHOOL_KEY: { label: 'School portal key', hint: 'The last part of https://foresatt.visma.no/<key>. Filled in for you when you log in, if the portal tells us.', secret: false },
    FLYT_EVENTS: { label: 'Weekly plans in the calendar', hint: 'on (default) or off. Reads the PDF and Word files on recent school messages and puts what\'s on each day (trips, gym, when school ends, homework) on a calendar of its own in Clearsky.', secret: false },
    FLYT_CALENDAR: { label: 'Calendar for weekly plans', hint: 'The name of that calendar, School by default. Hide or show it from the day schedule like any other.', secret: false },
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
  manifest: {
    secrets: [{ kind: 'web-session', note: 'the three cookies from your BankID login, in the GNOME keyring (or ~/.config/clearsky/flyt-session.json)' }],
    hosts: ['foresatt.visma.no', 'api.foresatt.visma.no'],
    files: ['~/.config/clearsky/flyt-session.json', '~/.config/clearsky/school-events.json'],
    clis: ['pdftotext'],
    note: 'The login opens a browser window on ID-porten; only the cookies for the school portal are kept.',
  },
  enabled: (env) => !!env.FLYT_SCHOOL_KEY,
  // An inbox: everything from school, newest first, by School or child. The count is what's unread.
  panel: { title: 'School', zone: 'needs', view: 'table' },

  async fetch(ctx) {
    const data = await collectFlyt();
    const out = { ...data, customerKey: data.customerKey || ctx.env.FLYT_SCHOOL_KEY };
    if (/^(off|no|false|0)$/i.test(ctx.env.FLYT_EVENTS || '')) return out;
    // The weekly plans: a problem with them shouldn't hide the messages.
    try {
      out.planEvents = (await schoolEvents(inbox(out), { readFile: (key, id) => flytFile(key, id, out), file: CACHE, log: (m) => console.error(m) }))
        .map((e) => ({ ...e, calendar: ctx.env.FLYT_CALENDAR || 'School' }));
    } catch (e) { out.planError = e.message; }
    return out;
  },

  items: (d) => inbox(d).map((m) => ({
    key: m.key, stamp: m.stamp, url: portalUrl(d.customerKey), detail: true,
    title: m.title, quote: m.body, at: m.at, from: m.from || 'The school', group: m.group, files: m.files, unread: m.unread,
    badge: WHAT[m.what], tone: m.unread && (m.what === 'form' || m.what === 'consent') ? 'amber' : undefined,
    meta: m.deadline ? `Answer by ${m.deadline.slice(0, 10)}` : m.thread ? `in ${m.thread}` : undefined,
  })),

  // The whole message, notice or form, and its files, read inside Clearsky.
  detail: (key, ctx, data) => readFlyt(key, data),
  attachment: (key, id, ctx, data) => flytFile(key, id, data),

  attention: (d) => waiting(d).map((w) => ({
    key: w.key, stamp: w.stamp, at: w.at, url: portalUrl(d.customerKey),
    title: `${w.child}: ${w.title || WHAT[w.what]}`, body: w.body || WHAT[w.what],
  })),

  // Deadlines on forms you haven't answered, as reminders that don't block time, and what the
  // weekly plans say is on each day.
  events: (d) => [
    ...waiting(d).filter((w) => w.deadline).map((w) => ({
      uid: w.key, title: `${w.child}: answer "${w.title}"`, start: w.deadline, end: w.deadline, allDay: false, fyi: true,
    })),
    ...(d.planEvents || []),
  ],
};
