// A chat's open cards (questions waiting for your answer) when its turn ends.
//
// Most cards hold the turn until you answer, so they can't outlive it. The ones held at the
// sandbox's proxy can (the host door, a GitHub change): Copilot's request gives up, the turn goes
// on and ends, and the card is left behind. Nothing shows it any more (the chat's history comes
// from Copilot, which never saw the card), yet the chat would still say "needs your OK". So the
// turn's end takes them down: a card only this chat had is answered as expired (not a Deny); a
// card other working chats show too stays with them and only leaves this chat.
export function closeCards(c) {
  const ids = [...c.waiting.keys()];
  for (const id of ids) {
    const answer = c.waiting.get(id);
    if (!answer) continue; // answered meanwhile (a shared card's answer clears every chat)
    c.emit?.({ type: 'permission-done', id, expired: true });
    const shared = c.shared?.has(id);
    c.waiting.delete(id); c.pending?.delete(id); c.shared?.delete(id);
    if (!shared) answer({ outcome: 'cancelled', expired: true });
  }
  return ids.length;
}
