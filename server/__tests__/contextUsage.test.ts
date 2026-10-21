import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { CONTEXT_SEED_TAIL_BYTES, DEFAULT_MAX_CONTEXT_TOKENS } from '../src/constants.js';
import {
  extractContextTokens,
  promptText,
  seedContextUsage,
  seedSessionSummary,
  updateContextUsage,
  widenContextWindow,
} from '../src/contextUsage.js';
import { toWindows } from '../src/planUsage.js';
import { claudeProvider, contextWindowForModel } from '../src/providers/hook/claude/claude.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'session',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
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
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    ...overrides,
  } as AgentState;
}

/** Assistant record shaped like Claude's: caching makes input_tokens tiny. */
function assistantRecord(
  opts: {
    input?: number;
    cacheCreation?: number;
    cacheRead?: number;
    output?: number;
    isSidechain?: boolean;
    id?: string;
  } = {},
): Record<string, unknown> {
  return {
    type: 'assistant',
    isSidechain: opts.isSidechain ?? false,
    message: {
      id: opts.id,
      model: 'claude-opus-5',
      usage: {
        input_tokens: opts.input ?? 2,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        output_tokens: opts.output ?? 0,
      },
    },
  };
}

describe('extractContextTokens', () => {
  it('counts cached prompt tokens, which dominate a real turn', () => {
    expect(
      extractContextTokens(
        assistantRecord({ input: 2, cacheCreation: 501, cacheRead: 443_937, output: 240 }),
      ),
    ).toBe(444_680);
  });

  it('reports nothing for records without usage', () => {
    expect(extractContextTokens({ type: 'user', message: { content: 'hi' } })).toBe(0);
    expect(extractContextTokens({ type: 'progress' })).toBe(0);
    expect(extractContextTokens(null)).toBe(0);
    expect(extractContextTokens('not a record')).toBe(0);
  });

  it('reports nothing for synthetic records, whose usage is all zeros', () => {
    expect(
      extractContextTokens({
        type: 'assistant',
        message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } },
      }),
    ).toBe(0);
  });
});

describe('claudeProvider.contextWindowForModel', () => {
  it('gives the current models their large window', () => {
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-opus-4-8']) {
      expect(contextWindowForModel(model)).toBe(1_000_000);
    }
  });

  it('gives Haiku and the older line the small window', () => {
    for (const model of [
      'claude-haiku-4-5-20251001',
      'claude-3-5-sonnet-20241022',
      'claude-opus-4-1-20250805',
    ]) {
      expect(contextWindowForModel(model)).toBe(200_000);
    }
  });

  it('answers nothing for models it cannot place, rather than guessing', () => {
    expect(contextWindowForModel(undefined)).toBeUndefined();
    expect(contextWindowForModel('<synthetic>')).toBeUndefined();
  });
});

describe('widenContextWindow', () => {
  it('never reports a window below the default', () => {
    expect(widenContextWindow(1_000, 0)).toBe(DEFAULT_MAX_CONTEXT_TOKENS);
  });

  it('jumps to the next known tier once a context outgrows the default', () => {
    expect(widenContextWindow(444_680, DEFAULT_MAX_CONTEXT_TOKENS)).toBe(1_000_000);
  });

  it('never shrinks, so compaction does not make the gauge lurch', () => {
    expect(widenContextWindow(20_476, 1_000_000)).toBe(1_000_000);
  });

  it('rounds up past the largest known tier instead of pinning at 100%', () => {
    expect(widenContextWindow(1_400_000, DEFAULT_MAX_CONTEXT_TOKENS)).toBe(2_000_000);
  });
});

describe('updateContextUsage', () => {
  let agents: AgentStateStore;
  let agent: AgentState;
  let messages: Array<Record<string, unknown>>;

  beforeEach(() => {
    agents = new AgentStateStore();
    agent = createTestAgent();
    agents.set(1, agent);
    messages = [];
    agents.on('broadcast', (msg) => messages.push(msg as Record<string, unknown>));
  });

  it('broadcasts the context of the newest turn', () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 50_000, output: 300 }));

    expect(messages).toEqual([
      {
        type: 'agentContextUsage',
        id: 1,
        contextTokens: 50_302,
        maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
        totalTokens: 50_302,
        inputTokens: 2,
        cacheWriteTokens: 0,
        cacheReadTokens: 50_000,
        outputTokens: 300,
      },
    ]);
  });

  it('splits spend by counter and prices it, 1-hour cache writes at 2x input', () => {
    const record = assistantRecord({ cacheRead: 1_000_000, output: 1_000, cacheCreation: 100_000 });
    (record.message as { usage: Record<string, unknown> }).usage.cache_creation = {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: 100_000,
    };
    updateContextUsage(1, agent, agents, record, claudeProvider);

    // claude-opus-5: $5 in, $25 out, $0.50 cache read, $10 cache write (1h).
    // The million cached tokens cost a third of what 100k cache writes do.
    expect(agent.spend).toMatchObject({
      inputTokens: 2,
      cacheWriteTokens: 100_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000,
    });
    expect(agent.spend?.costUsd).toBeCloseTo(0.00001 + 0.5 + 0.025 + 1, 6);
    expect(messages.at(-1)?.costUsd).toBeCloseTo(1.52501, 6);
  });

  it('withholds the cost once any response comes from an unpriced model', () => {
    updateContextUsage(1, agent, agents, assistantRecord({ id: 'a', output: 10 }), claudeProvider);
    const unknown = assistantRecord({ id: 'b', output: 10 });
    (unknown.message as { model: string }).model = 'claude-3-opus-20240229';
    updateContextUsage(1, agent, agents, unknown, claudeProvider);

    expect(agent.spend?.costUsd).toBeNull();
    expect(messages.at(-1)).not.toHaveProperty('costUsd', expect.anything());
  });

  it('sums spend across responses, counting a response split over records once', () => {
    // One response = one record per content block, each repeating its usage.
    for (let i = 0; i < 3; i++) {
      updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 1_000, id: 'msg_a' }));
    }
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 2_000, id: 'msg_b' }));

    expect(agent.totalTokens).toBe(1_002 + 2_002);
    expect(agent.contextTokens).toBe(2_002);
  });

  it('snapshots rather than accumulates: the gauge falls after a compaction', () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 240_000 }));
    expect(agent.contextTokens).toBe(240_002);
    expect(agent.maxContextTokens).toBe(1_000_000);

    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 20_000 }));
    expect(agent.contextTokens).toBe(20_002);
    // The window learned from the pre-compaction turn stays put.
    expect(agent.maxContextTokens).toBe(1_000_000);
  });

  it('leaves the gauge alone for records that report nothing', () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 50_000 }));
    updateContextUsage(1, agent, agents, { type: 'user', message: { content: 'next prompt' } });

    expect(agent.contextTokens).toBe(50_002);
    expect(messages).toHaveLength(1);
  });

  it("ignores a lead's sidechain records -- those turns are its sub-agents'", () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 120_000 }));
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 8_000, isSidechain: true }));

    expect(agent.contextTokens).toBe(120_002);
    // ...but they are this conversation's spend, so only the total moves.
    expect(agent.totalTokens).toBe(128_004);
    expect(messages.at(-1)).toMatchObject({ contextTokens: 120_002, totalTokens: 128_004 });
  });

  it("measures against the provider's window for the model that wrote the turn", () => {
    // Real numbers: a fresh Opus 5 session's first turn. Against the 200k
    // default this reads 17% -- five times what Claude Code itself reports.
    updateContextUsage(
      1,
      agent,
      agents,
      assistantRecord({ input: 2, cacheCreation: 12_753, cacheRead: 20_623, output: 226 }),
      claudeProvider,
    );

    expect(agent.contextTokens).toBe(33_604);
    expect(agent.maxContextTokens).toBe(1_000_000);
  });

  it('follows the window down when the session switches to a smaller model', () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 50_000 }), claudeProvider);
    expect(agent.maxContextTokens).toBe(1_000_000);

    updateContextUsage(
      1,
      agent,
      agents,
      {
        ...assistantRecord({ cacheRead: 50_000 }),
        message: { model: 'claude-haiku-4-5-20251001', usage: { cache_read_input_tokens: 50_000 } },
      },
      claudeProvider,
    );
    expect(agent.maxContextTokens).toBe(200_000);
  });

  it('widens past the declared window rather than showing more than 100%', () => {
    updateContextUsage(
      1,
      agent,
      agents,
      {
        type: 'assistant',
        message: {
          model: 'claude-haiku-4-5-20251001',
          usage: { cache_read_input_tokens: 260_000 },
        },
      },
      claudeProvider,
    );

    expect(agent.maxContextTokens).toBe(1_000_000);
  });

  it('reads sidechain records in a teammate transcript, which has nothing else', () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 44_651, isSidechain: true }));
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 53_695, isSidechain: true }));

    expect(agent.contextTokens).toBe(53_697);
    expect(messages).toHaveLength(2);
  });
});

describe('seedContextUsage', () => {
  let tmpDir: string;
  let agents: AgentStateStore;
  let messages: Array<Record<string, unknown>>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-context-'));
    agents = new AgentStateStore();
    messages = [];
    agents.on('broadcast', (msg) => messages.push(msg as Record<string, unknown>));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTranscript(name: string, records: Array<Record<string, unknown>>): string {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  }

  function seedAgent(jsonlFile: string, overrides: Partial<AgentState> = {}): AgentState {
    const agent = createTestAgent({ jsonlFile, ...overrides });
    agents.set(agent.id, agent);
    seedContextUsage(agent.id, agents);
    return agent;
  }

  it('seeds from the newest turn so a mid-session adoption has a gauge immediately', () => {
    const file = writeTranscript('session.jsonl', [
      assistantRecord({ cacheRead: 10_000 }),
      assistantRecord({ cacheRead: 90_000 }),
      { type: 'user', message: { content: 'a prompt with no usage' } },
    ]);

    const agent = seedAgent(file);

    expect(agent.contextTokens).toBe(90_002);
    expect(messages).toHaveLength(1);
  });

  it('prefers the main chain over a sub-agent turn recorded after it', () => {
    const file = writeTranscript('lead.jsonl', [
      assistantRecord({ cacheRead: 150_000 }),
      assistantRecord({ cacheRead: 5_000, isSidechain: true }),
    ]);

    expect(seedAgent(file).contextTokens).toBe(150_002);
  });

  it('falls back to sidechain records for a teammate transcript', () => {
    const file = writeTranscript('teammate.jsonl', [
      assistantRecord({ cacheRead: 44_651, isSidechain: true }),
      assistantRecord({ cacheRead: 53_695, isSidechain: true }),
    ]);

    expect(seedAgent(file).contextTokens).toBe(53_697);
  });

  it('reads only the tail, skipping the record the read landed inside', () => {
    const filler = { type: 'user', message: { content: 'x'.repeat(4_000) } };
    const fillerCount = Math.ceil(CONTEXT_SEED_TAIL_BYTES / 4_000) + 10;
    const file = writeTranscript('long.jsonl', [
      assistantRecord({ cacheRead: 1_000 }),
      ...Array.from({ length: fillerCount }, () => filler),
      assistantRecord({ cacheRead: 77_000 }),
    ]);
    expect(fs.statSync(file).size).toBeGreaterThan(CONTEXT_SEED_TAIL_BYTES);

    expect(seedAgent(file).contextTokens).toBe(77_002);
  });

  it('stays quiet for a transcript with no turns yet, and for a missing file', () => {
    seedAgent(writeTranscript('fresh.jsonl', [{ type: 'user', message: { content: 'hello' } }]));
    seedAgent(path.join(tmpDir, 'gone.jsonl'), { id: 2 });

    expect(messages).toHaveLength(0);
  });

  it('leaves an agent that already reported its context untouched', () => {
    const file = writeTranscript('known.jsonl', [assistantRecord({ cacheRead: 90_000 })]);

    const agent = seedAgent(file, { contextTokens: 12_345 });

    expect(agent.contextTokens).toBe(12_345);
    expect(messages).toHaveLength(0);
  });
});

describe('seedSessionSummary', () => {
  let tmpDir: string;
  let agents: AgentStateStore;
  let messages: Array<Record<string, unknown>>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-summary-'));
    agents = new AgentStateStore();
    messages = [];
    agents.on('broadcast', (msg) => messages.push(msg as Record<string, unknown>));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Adopt a transcript the way the scanner does: watching starts at EOF. */
  function adopt(records: Array<Record<string, unknown>>): AgentState {
    const file = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    const agent = createTestAgent({ jsonlFile: file, fileOffset: fs.statSync(file).size });
    agents.set(agent.id, agent);
    seedSessionSummary(agent.id, agents);
    return agent;
  }

  const prompt = { type: 'user', message: { content: 'do the thing' } };
  const reply = (at: string, id: string) => ({
    ...assistantRecord({ cacheRead: 1_000, id }),
    timestamp: at,
    message: {
      id,
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 2, cache_read_input_tokens: 1_000 },
    },
  });
  // Claude Desktop writes no turn_duration; this is its turn end.
  const desktopTurnEnd = (at: string) => ({
    type: 'system',
    subtype: 'stop_hook_summary',
    timestamp: at,
  });

  it('finds a conversation that answered and was never read, with when it answered', () => {
    const agent = adopt([
      prompt,
      reply('2026-10-03T10:00:00.000Z', 'msg_1'),
      reply('2026-10-03T10:00:00.000Z', 'msg_1'),
      desktopTurnEnd('2026-10-03T10:00:01.000Z'),
    ]);

    expect(agent.isWaiting).toBe(true);
    expect(agent.waitingSince).toBe(Date.parse('2026-10-03T10:00:01.000Z'));
    expect(agent.totalTokens).toBe(1_002);
    expect(agent.lastPrompt).toBe('do the thing');
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'agentStatus',
        status: 'waiting',
        since: agent.waitingSince,
      }),
    );
  });

  it('is not waiting once the user replied after the turn end', () => {
    const agent = adopt([
      prompt,
      reply('2026-10-03T10:00:00.000Z', 'msg_1'),
      desktopTurnEnd('2026-10-03T10:00:01.000Z'),
      prompt,
    ]);

    expect(agent.isWaiting).toBe(false);
    expect(messages.some((m) => m.type === 'agentStatus')).toBe(false);
  });

  it('a local slash command after the turn end keeps the conversation waiting', () => {
    const agent = adopt([
      prompt,
      reply('2026-10-03T10:00:00.000Z', 'msg_1'),
      desktopTurnEnd('2026-10-03T10:00:01.000Z'),
      { type: 'user', isMeta: true, message: { content: '<local-command-caveat>...' } },
      { type: 'user', message: { content: '<command-name>/context</command-name>' } },
      { type: 'system', subtype: 'local_command', content: '<local-command-stdout>..' },
    ]);

    expect(agent.waitingSince).toBe(Date.parse('2026-10-03T10:00:01.000Z'));
  });

  it('an interrupt mid-tool is the turn end', () => {
    const agent = adopt([
      prompt,
      {
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] },
      },
      {
        type: 'user',
        timestamp: '2026-10-03T10:00:02.000Z',
        message: {
          content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
        },
      },
    ]);

    expect(agent.waitingSince).toBe(Date.parse('2026-10-03T10:00:02.000Z'));
  });

  it('treats a trailing text-only reply as the turn end when no marker was written', () => {
    const agent = adopt([prompt, reply('2026-10-03T10:00:00.000Z', 'msg_1')]);

    expect(agent.waitingSince).toBe(Date.parse('2026-10-03T10:00:00.000Z'));
  });

  it('finds a conversation left on an open question', () => {
    const asked = {
      type: 'assistant',
      timestamp: '2026-10-03T10:00:00.000Z',
      message: { id: 'msg_1', content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion' }] },
    };
    const file = path.join(tmpDir, 'asked.jsonl');
    fs.writeFileSync(file, [prompt, asked].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    const agent = createTestAgent({ jsonlFile: file, fileOffset: fs.statSync(file).size });
    agents.set(agent.id, agent);
    seedSessionSummary(agent.id, agents, claudeProvider);

    expect(agent.waitingSince).toBe(Date.parse('2026-10-03T10:00:00.000Z'));
  });

  it('is not waiting while a tool call is still open', () => {
    const agent = adopt([
      prompt,
      {
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] },
      },
    ]);

    expect(agent.isWaiting).toBe(false);
  });
});

describe('promptText', () => {
  it('keeps what the user typed and skips what the harness injected', () => {
    expect(promptText({ type: 'user', message: { content: 'fix the login\nplease' } })).toBe(
      'fix the login',
    );
    expect(promptText({ type: 'user', message: { content: [{ type: 'text', text: 'oi' }] } })).toBe(
      'oi',
    );
    for (const injected of [
      { type: 'user', isMeta: true, message: { content: '[Image: original 390x3533]' } },
      { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
      { type: 'user', message: { content: '[Request interrupted by user for tool use]' } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
      { type: 'assistant', message: { content: 'not a prompt' } },
    ]) {
      expect(promptText(injected)).toBeUndefined();
    }
  });
});

describe('planUsage toWindows', () => {
  it('maps the limits Claude reports into 5h / weekly / per-model windows', () => {
    // Shape of the real response (trimmed).
    expect(
      toWindows([
        {
          kind: 'session',
          group: 'session',
          percent: 9,
          resets_at: '2026-10-03T15:10:00+00:00',
          scope: null,
        },
        {
          kind: 'weekly_all',
          group: 'weekly',
          percent: 15,
          resets_at: '2026-10-05T03:00:00+00:00',
          scope: null,
        },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 0,
          resets_at: '2026-10-05T03:00:00+00:00',
          scope: { model: { display_name: 'Fable' } },
        },
      ]),
    ).toEqual([
      {
        kind: 'session',
        model: undefined,
        percent: 9,
        resetsAt: Date.parse('2026-10-03T15:10:00Z'),
      },
      {
        kind: 'weekly',
        model: undefined,
        percent: 15,
        resetsAt: Date.parse('2026-10-05T03:00:00Z'),
      },
      {
        kind: 'weekly_model',
        model: 'Fable',
        percent: 0,
        resetsAt: Date.parse('2026-10-05T03:00:00Z'),
      },
    ]);
  });
});
