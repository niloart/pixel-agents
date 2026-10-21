/**
 * "Seen" in the inbox must never kill a terminal: in VS Code, closeAgent disposes a
 * terminal-backed agent's terminal (VS Code) or embedded PTY (standalone). canSendOffOnSeen gates which agents the inbox
 * may send closeAgent for.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { canSendOffOnSeen } from '../src/components/inboxSeen.js';

test('VS Code: terminal-backed agent is never sent off', () => {
  assert.equal(canSendOffOnSeen({ isHeadless: false }, false, false), false);
  assert.equal(canSendOffOnSeen({}, false, false), false);
});

test('VS Code: headless (no terminal) agent is sent off', () => {
  assert.equal(canSendOffOnSeen({ isHeadless: true }, false, false), true);
});

test('standalone: an agent without an embedded terminal is sent off', () => {
  assert.equal(canSendOffOnSeen({}, true, false), true);
});

test('standalone: an agent with a live embedded terminal is never sent off', () => {
  assert.equal(canSendOffOnSeen({}, true, true), false);
});

test('unknown character: nothing is sent', () => {
  assert.equal(canSendOffOnSeen(undefined, true, false), false);
});
