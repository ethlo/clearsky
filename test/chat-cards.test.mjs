import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeCards } from '../lib/chat-cards.mjs';

const chat = () => ({ waiting: new Map(), pending: new Map(), shared: new Set(), events: [], emit(e) { this.events.push(e); } });

test('a card left open when the turn ends is taken down as expired, so the chat no longer needs you', () => {
  const c = chat(), got = [];
  c.waiting.set('h1', (a) => got.push(a));
  c.pending.set('h1', { type: 'permission', id: 'h1' });
  assert.equal(closeCards(c), 1);
  assert.deepEqual(got, [{ outcome: 'cancelled', expired: true }]);
  assert.equal(c.waiting.size, 0);
  assert.equal(c.pending.size, 0);
  assert.deepEqual(c.events, [{ type: 'permission-done', id: 'h1', expired: true }]);
});

test('a card other working chats show too only leaves this chat', () => {
  const c = chat(), got = [];
  c.waiting.set('g1', (a) => got.push(a));
  c.shared.add('g1');
  closeCards(c);
  assert.deepEqual(got, [], 'not answered: the other chat can still answer it');
  assert.equal(c.waiting.size, 0);
  assert.equal(c.shared.size, 0);
});

test('nothing open: nothing to do', () => assert.equal(closeCards(chat()), 0));
