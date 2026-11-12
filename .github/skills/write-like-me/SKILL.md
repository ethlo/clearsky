---
name: write-like-me
description: Write review comments, replies, PR descriptions, ticket comments and Slack messages in my own voice. Use whenever drafting text that will be posted as me, or when I ask to make a draft sound like me.
---

# Write like me

Anything posted as me (a review comment, a reply on a PR or ticket, a PR description, a Jira
comment, a Slack message) should read as if I wrote it.

1. **Read my voice profile first:** `~/.copilot/voice.md`, if it's there. It describes how I
   write and has real samples of my own comments. It's mine and stays on this machine: never
   copy it, or the samples in it, into a repo, a PR, a ticket or anywhere else.
2. **Then write the way the profile says.** Where it says nothing, these hold:
   - Lead with the point: the ask, the problem or the answer, in the first sentence.
   - As short as the reader needs. A one-line fix gets one line; detail only where someone
     would otherwise have to ask, such as a concrete failing case, or why not the obvious way.
   - Plain words. No filler ("Great question", "I hope this helps", "Just a small nit"), no
     sign-off, no summary of what was just said, no headings in a comment.
   - Say what to do, not what might be considered: "Use `Optional` here" rather than
     "It might be worth considering whether…".
   - A question when I'm asking, not a statement dressed as one.
   - The language of the thread: Norwegian in a Norwegian thread, English otherwise.
   - Code, names and paths in backticks; a suggestion block when the change is small and exact.
   - Don't explain the reviewer's own code back to them, and don't repeat the diff in words.
3. **Keep it light.** Text that is correct but dense is still wrong for me. A colleague should
   get it in one read, without opening the code.
   - One idea per sentence. Most sentences under 20 words.
   - Say what changes and why in everyday words first. Code names come after, and only the
     ones the reader will search for or type. Two or three per paragraph is plenty.
   - No parentheses, no arrows, no slashes between alternatives ("DONE/FAILED", "a -> b").
     If it matters, give it its own sentence. If not, drop it.
   - A bullet is one short line. If a bullet needs a second clause, it's a paragraph.
   - Don't list every case. Name the rule, then the one exception that matters.
   - Leave out what the reader can't act on: internal class names, topic names, column names,
     unless the text is the spec someone will build from.
4. **Fit the place:** a review comment is about one thing on one line; a reply answers the
   question asked and says what changed ("Fixed in abc123" is a complete reply); a PR
   description follows its own format (the repo's template, or my standard sections) but in
   my voice. A Jira description is three short parts: the problem, what we'll do, and what's
   still open. No "Today / Change / To consider" scaffolding unless the ticket needs it.
   Write Jira text in Markdown (`## Heading`, `- item`, `` `code` ``), never wiki markup
   (`h3.`, `{{code}}`): Clearsky's `acli` and `ticket` send it to Jira as rich text.
   Leave out "out of scope" lines for things nobody would expect in it; name only what a
   reader could reasonably think is included.
5. **Before showing a draft,** cut it once more: every sentence I wouldn't miss goes. Then
   check it: when rewording, the meaning stays the same (a "not really" can flip an answer);
   one hedge at most ("seems" and "likely" together is one too many); what I'll do is a
   decision ("I'll do that as a follow-up"), not an offer. Last, read it as someone who
   hasn't seen the code: if a sentence needs a second read, split it or say it plainer.
6. **Check facts the fast way:** a claim in the draft (a version, where something is logged,
   what a rule does) is worth checking, but start the lookups that don't depend on each other
   together, several tool calls in one step, instead of one at a time.
7. **Never post it yourself** unless I've asked you to post; show it ready to paste or ready
   for me to approve.

To update the profile, ask Copilot to read my recent comments again (GitHub and the tracker, with
`gh` and `ticket`) and rewrite `~/.copilot/voice.md`: what I do, with a dozen short samples.
Leave out comments an agent drafted under my name (they read like an agent: "Fixed in <sha>:
…", "ready for human review after N rounds", sectioned summaries), or the profile learns the
agent's voice instead of mine. Chat messages I typed are good for tone. Keep the profile's
"Check every draft against this" section as it is: those are corrections I made.
