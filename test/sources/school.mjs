// A stand-in extra source for tests, shaped like a school app.
export default {
  name: 'school',
  label: 'School',
  settings: { SCHOOL_CHILD: { label: 'Child', hint: 'First name' }, SCHOOL_TOKEN: { label: 'Token', secret: true } },
  enabled: (env) => !!env.SCHOOL_CHILD,
  panel: { title: 'School', zone: 'track' },
  // A login like BankID's: takes a moment, and can tell the app who the child is.
  login: {
    label: 'Log in with Testid',
    status: () => ({ loggedIn: !!globalThis.schoolLoggedIn, detail: globalThis.schoolLoggedIn ? 'Logged in' : 'Not logged in' }),
    start: async () => {
      await new Promise((r) => setTimeout(r, 300));
      globalThis.schoolLoggedIn = true;
      return { settings: { SCHOOL_CHILD: 'Bea', GITHUB_TOKEN: 'not yours to set' } };
    },
  },
  // Read in Clearsky: the message in full, and a file that must never run as a page.
  detail: (key, ctx, data) => ({ title: 'Trip on Friday', child: data.child, messages: [{ from: 'Teacher', text: 'Bring a packed lunch', attachments: [{ id: 'f1', name: 'trip.html' }] }] }),
  attachment: (key, id) => ({ data: Buffer.from('<script>alert(1)</script>'), type: 'text/html', name: 'trip.html' }),
  async fetch(ctx) {
    if (ctx.env.SCHOOL_CHILD === 'expired') throw Object.assign(new Error('Log in again'), { auth: true });
    const at = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };
    return { child: ctx.env.SCHOOL_CHILD, messages: [{ id: 'm1', from: 'Teacher', text: 'Trip on Friday', at: at(8) }],
      lessons: [{ id: 'l1', title: 'Swimming', start: at(12), end: at(13) }] };
  },
  items: (d) => d.messages.map((m) => ({ key: m.id, stamp: m.at, at: m.at, unread: true, title: `${m.from}: ${m.text}`, meta: d.child, url: 'https://school.example/m1', detail: true })),
  attention: (d) => d.messages.map((m) => ({ key: m.id, stamp: m.at, at: m.at, title: `Message from ${m.from}`, body: m.text, url: 'https://school.example/m1' })),
  events: (d) => d.lessons.map((l) => ({ uid: l.id, title: `${d.child}: ${l.title}`, start: l.start, end: l.end, allDay: false, fyi: true })),
  standup: (d) => ({ today: d.lessons.map((l) => `${d.child} has ${l.title}`) }),
};
