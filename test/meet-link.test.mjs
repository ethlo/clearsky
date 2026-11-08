import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetLink } from '../lib/modules/calendar.mjs';

test('a Meet link opens in the account its calendar belongs to', () => {
  assert.equal(meetLink('https://meet.google.com/abc-defg-hij', 'alex@example.com'), 'https://meet.google.com/abc-defg-hij?authuser=alex%40example.com');
  assert.equal(meetLink('https://meet.google.com/abc-defg-hij?authuser=0', 'alex@example.com'), 'https://meet.google.com/abc-defg-hij?authuser=alex%40example.com');
  assert.equal(meetLink('https://acme.zoom.us/j/123', 'alex@example.com'), 'https://acme.zoom.us/j/123', 'only Meet');
  assert.equal(meetLink('https://meet.google.com/abc-defg-hij', 'Family'), 'https://meet.google.com/abc-defg-hij', 'no address, no change');
  assert.equal(meetLink(null, 'alex@example.com'), null);
});
