// Which acli commands only read Jira (Clearsky runs those at once, lib/broker.mjs), by their
// arguments, never by parsing shell text. Shared by the shim here and by Clearsky.

// acli: viewing and searching Jira only reads.
function acliWrites(argv) {
  const s = argv.join(' ');
  return !(/\b(view|search|list|status)\b/.test(s) && !/\b(create|edit|transition|comment|link|assign|delete|update|archive|clone)\b/.test(s));
}

module.exports = { acliWrites };
