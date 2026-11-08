import { test } from 'node:test';
import assert from 'node:assert/strict';
test('in the container, Copilot folders that are not mounted are pointed out', async () => {
  const { unmounted } = await import('../lib/settings.mjs');
  const exists = (p) => p === '/home/m/dev';
  assert.deepEqual(unmounted('~/dev, ~/private', { inContainer: true, exists, home: '/home/m' }), ['~/private']);
  assert.deepEqual(unmounted('', { inContainer: true, exists, home: '/home/m' }), []);
  assert.deepEqual(unmounted('~/private', { inContainer: false, exists, home: '/home/m' }), []);
});
