#!/usr/bin/env node
// `copilot` in Clearsky's container: runs the real one in Copilot's own container (lib/runner.mjs).
import { runRemote } from '../lib/runner.mjs';

const [host, port] = (process.env.COPILOT_RUNNER || 'copilot:7790').split(':');
process.exitCode = await runRemote({ host, port: Number(port) || 7790, token: process.env.CLEARSKY_RUNNER_TOKEN, argv: process.argv.slice(2), cwd: process.cwd() });
