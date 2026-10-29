#!/usr/bin/env node
// Stand-in for the GitHub Copilot CLI in tests: lists skills, or streams back what it was asked.
const args = process.argv.slice(2);
if (args[0] === 'skill' && args[1] === 'list') {
  process.stdout.write('Personal skills:\n  standup - Write my stand-up\n\nBuiltin skills:\n  github-pr-media - Add media to PRs\n');
} else {
  const prompt = args[args.indexOf('-p') + 1];
  const flags = args.filter((a, i) => a.startsWith('--') || ['shell', 'write', 'plan'].includes(a) && args[i - 1]?.startsWith('--'));
  process.stdout.write('Hello ');
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ prompt, flags, session: args[args.indexOf('--session-id') + 1] || null,
      resume: args.includes('--resume'), model: args.includes('--model') ? args[args.indexOf('--model') + 1] : null,
      hasToken: !!process.env.GITHUB_TOKEN }));
  }, 50);
}
