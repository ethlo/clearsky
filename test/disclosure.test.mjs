import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelName, disclosureLine } from '../lib/disclosure.mjs';
import { parseUsage } from '../lib/copilot-events.mjs';
import { needs } from '../lib/broker.mjs';

test('model ids read the way people write them', () => {
  assert.equal(modelName('claude-opus-5.5'), 'Claude Opus 5.5');
  assert.equal(modelName('gpt-5.1-codex'), 'GPT-5.1 Codex');
  assert.equal(modelName('auto'), null);
  assert.equal(modelName(''), null);
});

test('the line says which model did the work and the credits it used', () => {
  assert.equal(disclosureLine({ models: ['claude-opus-5.5'], premium: 939 }), 'Implemented with Copilot (Claude Opus 5.5). 939 credits used.');
  assert.equal(disclosureLine({ models: [], premium: 1 }, 'gpt-5.1'), 'Implemented with Copilot (GPT-5.1). 1 credit used.');
  assert.equal(disclosureLine({ models: ['claude-opus-5.5', 'gpt-5.1'], premium: 2.25 }), 'Implemented with Copilot (Claude Opus 5.5 and GPT-5.1). 2.3 credits used.');
  assert.equal(disclosureLine(null, 'auto'), 'Implemented with Copilot.');
});

test('the session log gives the models and the credits', () => {
  const log = [
    JSON.stringify({ type: 'session.usage_record', data: { model: 'claude-opus-5.5', usage: { inputTokens: 10, outputTokens: 2, accounting: { usageId: 'a' } } } }),
    JSON.stringify({ type: 'session.usage_record', data: { usage: { model: 'claude-opus-5.5', inputTokens: 10, outputTokens: 2, accounting: { usageId: 'b' } } } }),
    JSON.stringify({ type: 'session.usage_checkpoint', data: { totalPremiumRequests: 939 } }),
  ].join('\n');
  const u = parseUsage(log);
  assert.deepEqual(u.models, ['claude-opus-5.5']);
  assert.equal(disclosureLine(u), 'Implemented with Copilot (Claude Opus 5.5). 939 credits used.');
  assert.equal(needs('usage', []), 'run', 'it only reads');
});
