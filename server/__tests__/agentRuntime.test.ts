import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { AgentState } from '../src/types.js';

/**
 * D5 gate (tier-3 multi-server hook fan-out plan): the hook script now
 * broadcasts every event to every live server (server/src/providers/hook/
 * claude/hooks/claude-hook.ts), so a server must never adopt a session it
 * doesn't own just because it received the event. HookEventHandler's own
 * isTrackedSession only gates debug logging (hookEventHandler.ts:173-174);
 * the actual gate is one hop downstream, in AgentRuntime's
 * onExternalSessionDetected callback (agentRuntime.ts:96-101), which drops
 * the session unless its project dir was scanned by this instance
 * (isTrackedProjectDir) or watchAllSessions is on. These tests exercise
 * that real callback end-to-end via handleHookEvent, not a mock.
 */
describe('AgentRuntime -- D5 foreign-session gate', () => {
  let runtime: AgentRuntime;
  let store: AgentStateStore;

  afterEach(() => {
    // Clears the project-scan interval and any polling timer from adoption.
    runtime?.dispose();
  });

  /** A directory guaranteed untracked by any other test in this file or
   *  process (isTrackedProjectDir's backing Set is module-level and only
   *  ever grows -- see fileWatcher.ts -- so uniqueness is what keeps tests
   *  from leaking into each other). */
  function untrackedDir(): string {
    return path.join(os.tmpdir(), `pxl-d5-test-${crypto.randomUUID()}`);
  }

  function fireSessionStartThenStop(sessionId: string, cwd: string): void {
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      source: 'startup',
      cwd,
    });
    runtime.handleHookEvent('claude', {
      hook_event_name: 'Stop',
      session_id: sessionId,
    });
  }

  it('drops a foreign session (unowned dir, watchAllSessions off): no agent created', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    // watchAllSessions defaults to false; this dir was never scanned/owned
    // by this instance -- exactly the "other server's session" scenario
    // fan-out introduces.
    fireSessionStartThenStop('d5-foreign-off', untrackedDir());
    expect(store.size).toBe(0);
  });

  it('adopts a foreign session when watchAllSessions is on', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;
    fireSessionStartThenStop('d5-foreign-on', untrackedDir());
    expect(store.size).toBe(1);
  });

  it('adopts a session under a project dir this instance has scanned, even with watchAllSessions off', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    const dir = untrackedDir();
    runtime.startProjectScan(dir); // marks `dir` as owned/tracked
    fireSessionStartThenStop('d5-tracked-dir', dir);
    expect(store.size).toBe(1);
  });
});

describe('AgentRuntime -- removeAgent cleanup', () => {
  let runtime: AgentRuntime;
  let store: AgentStateStore;

  afterEach(() => runtime?.dispose());

  function agent(overrides: Partial<AgentState>): AgentState {
    return {
      id: 1,
      sessionId: '',
      isExternal: true,
      projectDir: '/test',
      jsonlFile: `/test/${crypto.randomUUID()}.jsonl`,
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: 0,
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      hookDelivered: false,
      contextTokens: 0,
      maxContextTokens: 200_000,
      ...overrides,
    } as AgentState;
  }

  const stop = (sessionId: string) =>
    runtime.handleHookEvent('claude', { hook_event_name: 'Stop', session_id: sessionId });

  it('removing a lead takes its teammates with it; removing a session-sharing teammate leaves the lead live', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    store.set(1, agent({ id: 1, sessionId: 'sess-lead' }));
    store.set(2, agent({ id: 2, sessionId: 'sess-lead', leadAgentId: 1, spawnToolUseId: 'tu-1' }));
    store.set(3, agent({ id: 3, sessionId: 'sess-mate', leadAgentId: 1 }));
    runtime.registerAgent('sess-lead', 1);
    runtime.registerAgent('sess-mate', 3);

    runtime.removeAgent(2);
    stop('sess-lead');
    expect(store.get(1)?.isWaiting).toBe(true);

    runtime.removeAgent(1);
    expect(store.size).toBe(0);
  });

  it('unregisters the removed agent so its session no longer routes to a reused id', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    store.set(1, agent({ id: 1, sessionId: 'sess-gone' }));
    runtime.registerAgent('sess-gone', 1);

    runtime.removeAgent(1);
    const reused = agent({ id: 1, sessionId: 'sess-new' });
    store.set(1, reused);
    stop('sess-gone');

    expect(reused.isWaiting).toBe(false);
  });
});
