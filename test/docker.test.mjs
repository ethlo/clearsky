import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dockerMounts, mountsYaml } from '../lib/docker.mjs';

test('the container mounts Copilot\'s folders and the tool folders that exist, at the same paths', () => {
  const have = new Set(['/h/dev', '/h/dev/kezzler', '/h/private', '/h/.config/clearsky', '/h/.copilot', '/h/.m2', '/h/.jdks', '/h/.cache/evolution/calendar']);
  const mounts = dockerMounts({ folders: ['~/dev', '~/dev/kezzler', '~/private', '~/gone'], cwd: '/h/dev/kezzler', home: '/h', exists: (p) => have.has(p) });
  assert.deepEqual(mounts.map((m) => `${m.path}${m.ro ? ':ro' : ''}`),
    ['/h/dev', '/h/private', '/h/.config/clearsky', '/h/.copilot', '/h/.m2', '/h/.jdks:ro', '/h/.cache/evolution/calendar']);
  assert.match(mountsYaml(mounts), /- "\/h\/dev:\/h\/dev"\n/);
  assert.match(mountsYaml(mounts), /- "\/h\/.jdks:\/h\/.jdks:ro"\n/);
});
