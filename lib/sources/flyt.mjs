// School: what Visma Flyt Skole (Min Skole / Flyt Foresatt) has for your children. Log in once
// with BankID through `npm run flyt-login`; the login is kept in the GNOME keyring.

import { collectFlyt, waiting, portalUrl } from '../flyt.mjs';

const WHAT = { message: 'Message', notice: 'Notice', announcement: 'Announcement', form: 'Form to answer', consent: 'Consent to answer' };

export default {
  name: 'flyt',
  label: 'Visma Flyt Skole',
  settings: {
    FLYT_SCHOOL_KEY: { label: 'School portal key', hint: 'The last part of https://foresatt.visma.no/<key>. Then log in with npm run flyt-login', secret: false },
  },
  enabled: (env) => !!env.FLYT_SCHOOL_KEY,
  panel: { title: 'School', zone: 'needs' },

  async fetch(ctx) {
    const data = await collectFlyt();
    return { ...data, customerKey: data.customerKey || ctx.env.FLYT_SCHOOL_KEY };
  },

  items: (d) => waiting(d).map((w) => ({
    key: w.key, stamp: w.stamp, url: portalUrl(d.customerKey),
    title: w.title, meta: [w.child, w.from, w.deadline && `due ${w.deadline.slice(0, 10)}`].filter(Boolean).join(' · '),
    badge: w.count > 1 ? `${WHAT[w.what]} (${w.count})` : WHAT[w.what], tone: w.what === 'form' || w.what === 'consent' ? 'warn' : undefined,
    quote: w.body,
  })),

  attention: (d) => waiting(d).map((w) => ({
    key: w.key, stamp: w.stamp, url: portalUrl(d.customerKey),
    title: `${w.child}: ${w.title || WHAT[w.what]}`, body: w.body || WHAT[w.what],
  })),

  // Deadlines on forms you haven't answered, as reminders that don't block time.
  events: (d) => waiting(d).filter((w) => w.deadline).map((w) => ({
    uid: w.key, title: `${w.child}: answer "${w.title}"`, start: w.deadline, end: w.deadline, allDay: false, fyi: true,
  })),
};
