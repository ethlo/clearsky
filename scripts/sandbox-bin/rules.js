// Which commands the sandbox hands to Clearsky (lib/broker.mjs) and which run in it, by their
// arguments (never by parsing shell text). Shared by the shims here and by Clearsky, which
// checks again. Getting one wrong is harmless: the sandbox's GitHub token can only read, so a
// change that runs in here fails, and a read sent out just asks you.

// `git push` changes a remote; everything else git does stays in the clone or only reads.
function gitWrites(argv) {
  let a = argv;
  while (a[0] === '-C' || a[0] === '-c' || a[0] === '--no-pager') a = a.slice(a[0] === '--no-pager' ? 1 : 2);
  return a[0] === 'push';
}

// gh: looking (view, list, diff, checks, status, api GET) runs here; anything else is a change.
function ghWrites(argv) {
  const [sub, verb] = argv;
  if (sub === 'api') {
    const i = argv.findIndex((x) => x === '-X' || x === '--method');
    const method = i >= 0 ? argv[i + 1] : argv.map((x) => /^--method=(.+)/.exec(x)?.[1]).find(Boolean);
    const fields = argv.some((x) => /^(-f|-F|--field|--raw-field|--input)$/.test(x) || /^--(field|raw-field|input)=/.test(x));
    return (method ? method.toUpperCase() !== 'GET' : false) || fields;
  }
  if (sub === 'auth') return !/^(status|token|git-credential)$/.test(verb || '');
  return !(/^(pr|issue|run|repo|release|workflow|search|status|browse|label|cache|variable|ruleset)$/.test(sub || '')
    && /^(view|list|diff|checks|status|watch|download)?$/.test(verb || ''));
}

// acli: viewing and searching Jira only reads.
function acliWrites(argv) {
  const s = argv.join(' ');
  return !(/\b(view|search|list|status)\b/.test(s) && !/\b(create|edit|transition|comment|link|assign|delete|update|archive|clone)\b/.test(s));
}

module.exports = { gitWrites, ghWrites, acliWrites };
