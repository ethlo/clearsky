import { test } from 'node:test';
import assert from 'node:assert/strict';
import { untilde } from '../lib/util.mjs';

test('~ at the start of a path is your home folder, and nowhere else', () => {
  assert.equal(untilde('~/dev', '/home/you'), '/home/you/dev');
  assert.equal(untilde('~', '/home/you'), '/home/you');
  assert.equal(untilde('~other/dev', '/home/you'), '~other/dev');
  assert.equal(untilde('/srv/~/x', '/home/you'), '/srv/~/x');
  assert.equal(untilde('', '/home/you'), '');
});
