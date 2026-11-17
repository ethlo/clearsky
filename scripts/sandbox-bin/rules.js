// Which acli commands only read Jira (Clearsky runs those at once, lib/broker.mjs), by their
// arguments, never by parsing shell text. Shared by the shim here and by Clearsky.

// acli: viewing and searching Jira only reads.
function acliWrites(argv) {
  const s = argv.join(' ');
  return !(/\b(view|search|list|status)\b/.test(s) && !/\b(create|edit|transition|comment|link|assign|delete|update|archive|clone)\b/.test(s));
}

// acli is more than Jira: `acli rovodev` is an agent of its own with a shell, `acli admin` manages
// the organisation. The door is for Jira (and acli's own help and version), nothing else.
function acliJira(argv) {
  return argv[0] === 'jira' || !argv.length || argv.every((a) => /^(help|--help|-h|--version|-v)$/.test(a));
}

// The files an acli command reads on this machine (--from-file, --from-json, --description-file,
// --body-file…): Clearsky runs acli outside the sandbox, so these must be the chat's own.
// `-f` is --from-file on a change, and --fields (not a file) on a view or search.
function acliFiles(argv) {
  const out = [], writes = acliWrites(argv);
  argv.forEach((a, i) => {
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (!/^(--from-[\w-]+|--[\w-]*file|--body-adf|-F)$/.test(flag) && !(flag === '-f' && writes)) return;
    const v = eq > 0 ? a.slice(eq + 1) : argv[i + 1];
    if (typeof v === 'string' && v) out.push(v);
  });
  return out;
}

module.exports = { acliWrites, acliJira, acliFiles };
