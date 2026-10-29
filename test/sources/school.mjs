// A stand-in extra source for tests, shaped like a school app.
export default {
  name: 'school',
  label: 'School',
  settings: { SCHOOL_CHILD: { label: 'Child', hint: 'First name' }, SCHOOL_TOKEN: { label: 'Token', secret: true } },
  enabled: (env) => !!env.SCHOOL_CHILD,
  panel: { title: 'School', zone: 'track' },
  async fetch(ctx) {
    const at = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };
    return { child: ctx.env.SCHOOL_CHILD, messages: [{ id: 'm1', from: 'Teacher', text: 'Trip on Friday', at: at(8) }],
      lessons: [{ id: 'l1', title: 'Swimming', start: at(12), end: at(13) }] };
  },
  items: (d) => d.messages.map((m) => ({ key: m.id, stamp: m.at, title: `${m.from}: ${m.text}`, meta: d.child, url: 'https://school.example/m1' })),
  attention: (d) => d.messages.map((m) => ({ key: m.id, stamp: m.at, title: `Message from ${m.from}`, body: m.text, url: 'https://school.example/m1' })),
  events: (d) => d.lessons.map((l) => ({ uid: l.id, title: `${d.child}: ${l.title}`, start: l.start, end: l.end, allDay: false, fyi: true })),
  standup: (d) => ({ today: d.lessons.map((l) => `${d.child} has ${l.title}`) }),
};
