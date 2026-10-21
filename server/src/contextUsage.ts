import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';

import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  CONTEXT_SEED_TAIL_BYTES,
  CONTEXT_WINDOW_TIERS,
  DEFAULT_MAX_CONTEXT_TOKENS,
  TEXT_IDLE_DELAY_MS,
} from './constants.js';
import type { AgentState } from './types.js';

/**
 * How full an agent's context window is — the context gauge above every character.
 *
 * The number is a SNAPSHOT of the newest turn, never a running total: an
 * agent's context is whatever the last request carried, so it drops when the
 * session compacts or clears. Cached prompt tokens dominate that figure
 * (`input_tokens` alone is usually single digits once caching kicks in), so
 * all three prompt counters are summed plus what the model just wrote.
 */
interface UsageBlock {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  /** cache_creation_input_tokens split by TTL; the two are priced differently. */
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

/** Shape we care about; transcripts carry far more per record. */
interface TranscriptRecord {
  type?: string;
  isMeta?: boolean;
  permissionMode?: string;
  subtype?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: { id?: string; model?: string; usage?: UsageBlock; content?: unknown };
}

/**
 * Context size implied by one transcript record, or 0 when it says nothing.
 *
 * Zero covers three cases that all mean "no news": records without usage,
 * synthetic assistant messages (API errors, interrupts) which report all-zero
 * usage, and anything malformed. Callers treat 0 as "leave the gauge alone" —
 * a real context is never 0 once a turn has run.
 */
export function extractContextTokens(record: unknown): number {
  const usage = (record as TranscriptRecord | null)?.message?.usage;
  if (!usage || typeof usage !== 'object') return 0;
  const sum =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.output_tokens ?? 0);
  return Number.isFinite(sum) && sum > 0 ? sum : 0;
}

/**
 * Window an observed context has to fit in, when nobody can name it.
 *
 * The provider's answer for the model is the real source (see
 * `HookProvider.contextWindowForModel`); this is the backstop for unrecognized
 * models and for windows larger than anything we know about. It only ever
 * widens: a context that doesn't fit proves the assumption too small, while a
 * context that shrinks proves nothing (a 900k session compacted to 20k is
 * still running in a 1M window).
 */
export function widenContextWindow(observed: number, current: number): number {
  const window = Math.max(current || 0, DEFAULT_MAX_CONTEXT_TOKENS);
  for (const tier of CONTEXT_WINDOW_TIERS) {
    if (tier >= observed) return Math.max(window, tier);
  }
  const largest = CONTEXT_WINDOW_TIERS[CONTEXT_WINDOW_TIERS.length - 1];
  return Math.max(window, Math.ceil(observed / largest) * largest);
}

function applyContextTokens(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
  tokens: number,
  fromMainChain: boolean,
  declaredWindow: number | undefined,
): void {
  if (fromMainChain) agent.sawMainChainUsage = true;
  agent.contextTokens = tokens;
  // A named model wins over the running estimate -- switching models mid-session
  // genuinely changes the window, and the provider knows it while we're only
  // guessing from what we've seen.
  agent.maxContextTokens = widenContextWindow(tokens, declaredWindow ?? agent.maxContextTokens);
  broadcastUsage(agentId, agent, agents);
}

/** The agentContextUsage message for an agent -- live broadcasts and the
 *  reconnect resend both build it here so they can't drift apart. */
export function contextUsageMessage(agentId: number, agent: AgentState) {
  const spend = agent.spend;
  return {
    type: 'agentContextUsage',
    id: agentId,
    contextTokens: agent.contextTokens,
    maxContextTokens: agent.maxContextTokens,
    totalTokens: agent.totalTokens,
    inputTokens: spend?.inputTokens,
    cacheWriteTokens: spend?.cacheWriteTokens,
    cacheReadTokens: spend?.cacheReadTokens,
    outputTokens: spend?.outputTokens,
    costUsd: spend?.costUsd ?? undefined,
  };
}

function broadcastUsage(agentId: number, agent: AgentState, agents: AgentStateStore): void {
  agents.broadcast(contextUsageMessage(agentId, agent));
}

/**
 * What one response's usage costs at the provider's list price, in USD, or
 * null when the model can't be priced. Cache writes without a TTL breakdown
 * are priced as 5-minute writes, the API default.
 */
export function usageCostUsd(
  usage: UsageBlock,
  model: string | undefined,
  provider?: HookProvider | null,
): number | null {
  const price = provider?.pricingForModel?.(model);
  if (!price) return null;
  const write = usage.cache_creation_input_tokens ?? 0;
  const write1h = Math.min(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0, write);
  const perToken =
    (usage.input_tokens ?? 0) * price.input +
    (usage.output_tokens ?? 0) * price.output +
    (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
    (write - write1h) * price.cacheWrite5m +
    write1h * price.cacheWrite1h;
  return perToken / 1_000_000;
}

/**
 * Add one record to the conversation's running spend -- the one place a sum IS
 * the right number. A response is written as several consecutive records (one
 * per content block) that all repeat its usage, so each message.id counts once.
 * Sidechain records count too: a sub-agent's turns are this conversation's spend.
 * Sub-agent records interleave with the main chain's, so the ids seen recently
 * are remembered, not just the last one. Returns whether anything was added.
 */
function addToTotal(
  agent: AgentState,
  record: TranscriptRecord,
  tokens: number,
  provider?: HookProvider | null,
): boolean {
  const id = record.message?.id;
  if (id) {
    const seen = (agent.recentUsageMessageIds ??= []);
    if (seen.includes(id)) return false;
    seen.push(id);
    if (seen.length > RECENT_USAGE_IDS) seen.shift();
  }
  agent.totalTokens = (agent.totalTokens ?? 0) + tokens;
  const usage = record.message?.usage ?? {};
  const spend = (agent.spend ??= {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });
  spend.inputTokens += usage.input_tokens ?? 0;
  spend.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
  spend.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  spend.outputTokens += usage.output_tokens ?? 0;
  // One unpriced response makes the total unknowable; never show a low guess.
  const cost = usageCostUsd(usage, record.message?.model, provider);
  spend.costUsd = cost === null || spend.costUsd === null ? null : spend.costUsd + cost;
  return true;
}

/** Records of one response sit close together; this many ids covers any
 *  interleaving of parallel sub-agents while keeping the scan trivial. */
const RECENT_USAGE_IDS = 64;

/**
 * Forget the previous conversation's summary when an agent moves to a new
 * transcript (/clear, a restarted teammate): its spend, gauge, prompt and wait
 * all belong to the old file. The new file replays from offset 0.
 */
export function resetConversationSummary(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
): void {
  const hadUsage = agent.contextTokens > 0 || !!agent.totalTokens;
  agent.contextTokens = 0;
  agent.sawMainChainUsage = false;
  agent.totalTokens = undefined;
  agent.spend = undefined;
  agent.recentUsageMessageIds = undefined;
  agent.lastPrompt = undefined;
  agent.waitingSince = undefined;
  // totalTokens: 0 (not undefined) so the webview replaces the old spend.
  if (hadUsage) agents.broadcast({ ...contextUsageMessage(agentId, agent), totalTokens: 0 });
}

/**
 * Fold one freshly-read transcript record into the agent's context gauge.
 *
 * Sidechain records are another agent's turn, but WHOSE depends on the file:
 * in a lead's transcript they're its sub-agents (older Claude formats inline
 * them) and must not move the lead's gauge; a teammate's own transcript is
 * sidechain top to bottom and would otherwise never report anything. So the
 * rule is positional — once this file has produced a main-chain turn, later
 * sidechain records belong to someone else.
 */
export function updateContextUsage(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
  record: unknown,
  provider?: HookProvider | null,
): void {
  const tokens = extractContextTokens(record);
  if (tokens <= 0) return;
  const added = addToTotal(agent, record as TranscriptRecord, tokens, provider);
  const isSidechain = (record as TranscriptRecord | null)?.isSidechain === true;
  if (isSidechain && agent.sawMainChainUsage) {
    if (added) broadcastUsage(agentId, agent, agents); // the gauge stays, the spend moved
    return;
  }
  applyContextTokens(agentId, agent, agents, tokens, !isSidechain, windowFor(record, provider));
}

/** The provider's window for whichever model wrote this record. */
function windowFor(record: unknown, provider?: HookProvider | null): number | undefined {
  return provider?.contextWindowForModel?.((record as TranscriptRecord | null)?.message?.model);
}

/**
 * Seed the gauge from a transcript's tail when watching starts.
 *
 * Most agents are adopted or restored mid-session with `fileOffset` at
 * end-of-file, so streaming alone leaves them gauge-less until their next
 * turn — an office full of idle agents would show nothing. Reading the last
 * chunk backwards finds the newest usage record without replaying history.
 */
export function seedContextUsage(
  agentId: number,
  agents: AgentStateStore,
  provider?: HookProvider | null,
): void {
  const agent = agents.get(agentId);
  if (!agent || agent.contextTokens > 0 || !agent.jsonlFile) return;

  let text: string;
  try {
    const stat = fs.statSync(agent.jsonlFile);
    const start = Math.max(0, stat.size - CONTEXT_SEED_TAIL_BYTES);
    const length = stat.size - start;
    if (length <= 0) return;
    const fd = fs.openSync(agent.jsonlFile, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // A mid-file start lands inside a record; drop that fragment.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return; // unreadable transcript -- the stream will seed it on the next turn
  }

  // Newest first. Main-chain wins; sidechain is the fallback that makes
  // teammate transcripts (sidechain-only files) work.
  const lines = text.split('\n');
  let sidechain: { tokens: number; window: number | undefined } | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const tokens = extractContextTokens(record);
    if (tokens <= 0) continue;
    if ((record as TranscriptRecord).isSidechain === true) {
      sidechain ??= { tokens, window: windowFor(record, provider) };
      continue;
    }
    applyContextTokens(agentId, agent, agents, tokens, true, windowFor(record, provider));
    return;
  }
  if (sidechain) {
    applyContextTokens(agentId, agent, agents, sidechain.tokens, false, sidechain.window);
  }
}

/** Longest prompt excerpt kept per agent -- enough to recognise the task. */
const PROMPT_EXCERPT_CHARS = 120;

/**
 * First line of a prompt the user typed, or undefined for every other record:
 * tool results, sidechain turns, and the meta / `<command-...>` / interrupt
 * records the CLI and Desktop inject under the user role.
 */
export function promptText(record: unknown): string | undefined {
  const r = record as TranscriptRecord | null;
  if (r?.type !== 'user' || r.isMeta === true || r.isSidechain === true) return undefined;
  const content = r.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => (b as { type?: string } | null)?.type === 'text')
            .map((b) => (b as { text?: string }).text ?? '')
            .join('\n')
        : '';
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line || line.startsWith('<') || line.startsWith('[Request interrupted')) return undefined;
  return line.slice(0, PROMPT_EXCERPT_CHARS);
}

/**
 * Esc mid-turn. Ends the turn, but no turn-end marker follows and the Stop
 * hook doesn't fire on interrupts, so this record IS the turn end.
 */
export function isInterruptRecord(record: unknown): boolean {
  const r = record as TranscriptRecord | null;
  const content = r?.message?.content;
  return (
    r?.type === 'user' &&
    r.isSidechain !== true &&
    Array.isArray(content) &&
    /^\[Request interrupted by user/.test((content[0] as { text?: string } | null)?.text ?? '')
  );
}

/**
 * A slash command's echo (`<command-name>`, `<local-command-stdout>`...), not
 * a prompt. A local command ends there; a prompt command (skill) is followed by
 * the assistant turn it starts, which resets the wait on its own.
 */
function isLocalCommandEcho(record: TranscriptRecord): boolean {
  const content = record.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? ((content[0] as { text?: string } | null)?.text ?? '')
        : '';
  return /^\s*<(command-name|command-message|local-command-)/.test(text);
}

/**
 * Replay what was already on disk when watching started: the conversation's
 * spend so far, and whether its last turn ended waiting on the user.
 *
 * Adopted and restored agents start at end-of-file, so without this a
 * conversation that answered an hour ago shows no spend and no "waiting" until
 * it moves again -- the exact conversation the inbox exists to surface. One
 * full read per agent, bounded by the offset streaming takes over from.
 */
const SEED_CHUNK_BYTES = 1024 * 1024;

/** Every record seedSessionSummary reads carries usage, a permission mode, or
 *  a user/assistant/system type -- a cheap test that never rejects one of them. */
const SUMMARY_RECORD_HINT = /"usage"|"permissionMode"|"type"\s*:\s*"(?:user|assistant|system)"/;

export function seedSessionSummary(
  agentId: number,
  agents: AgentStateStore,
  provider?: HookProvider | null,
): void {
  const agent = agents.get(agentId);
  if (!agent?.jsonlFile || agent.fileOffset <= 0 || agent.totalTokens) return;

  // Last main-chain turn end not followed by new work, and a trailing
  // text-only reply (the turn end of sessions that write no end marker).
  let endedAt: number | null = null;
  let textAt: number | null = null;
  let mtimeMs = 0;
  const handleLine = (line: string): void => {
    // Only these records move the summary; transcripts are mostly other
    // record types and tool output, so skip parsing what can't matter.
    if (!line || !SUMMARY_RECORD_HINT.test(line)) return;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      return;
    }
    const tokens = extractContextTokens(record);
    if (tokens > 0) addToTotal(agent, record, tokens, provider);
    agent.lastPrompt = promptText(record) ?? agent.lastPrompt;
    if (typeof record.permissionMode === 'string') agent.permissionMode = record.permissionMode;
    if (record.isSidechain === true) return;
    const at = Date.parse(record.timestamp ?? '') || mtimeMs;
    if (
      record.type === 'system' &&
      (record.subtype === 'turn_duration' || record.subtype === 'stop_hook_summary')
    ) {
      endedAt = at;
    } else if (record.type === 'assistant') {
      const content = record.message?.content;
      const tools = Array.isArray(content)
        ? content.filter((b) => (b as { type?: string } | null)?.type === 'tool_use')
        : [];
      // A question or plan left open is a turn waiting on the user too.
      const asksUser = tools.some((b) =>
        provider?.userInputTools?.has((b as { name?: string }).name ?? ''),
      );
      endedAt = null;
      textAt = tools.length === 0 || asksUser ? at : null;
    } else if (isInterruptRecord(record)) {
      endedAt = at;
      textAt = null;
    } else if (record.type === 'user' && !isLocalCommandEcho(record)) {
      endedAt = textAt = null;
    }
  };

  // Chunked so a transcript of hundreds of MB never sits in memory at once.
  try {
    const fd = fs.openSync(agent.jsonlFile, 'r');
    try {
      mtimeMs = fs.fstatSync(fd).mtimeMs;
      const decoder = new StringDecoder('utf8');
      const buf = Buffer.alloc(Math.min(SEED_CHUNK_BYTES, agent.fileOffset));
      let partial = '';
      for (let pos = 0; pos < agent.fileOffset;) {
        const read = fs.readSync(fd, buf, 0, Math.min(buf.length, agent.fileOffset - pos), pos);
        if (read <= 0) break;
        pos += read;
        const lines = (partial + decoder.write(buf.subarray(0, read))).split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      }
      handleLine(partial + decoder.end());
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return; // unreadable transcript -- streaming still counts what comes next
  }

  const idle = Date.now() - mtimeMs > TEXT_IDLE_DELAY_MS;
  const since = endedAt ?? (idle ? textAt : null);
  if (since !== null && !agent.isWaiting) {
    agent.isWaiting = true;
    agent.waitingSince = since;
    agents.broadcast({
      type: 'agentStatus',
      id: agentId,
      status: 'waiting',
      since,
      prompt: agent.lastPrompt,
      awaitingInput: false,
    });
  }
  if (agent.totalTokens) broadcastUsage(agentId, agent, agents);
}
