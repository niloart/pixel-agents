import type * as vscode from 'vscode';

export interface TokenSpend {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface AgentState {
  id: number;
  sessionId: string;
  /** Terminal reference — undefined for extension panel sessions */
  terminalRef?: vscode.Terminal;
  /** Whether this agent was detected from an external source (VS Code extension panel, etc.) */
  isExternal: boolean;
  projectDir: string;
  jsonlFile: string;
  fileOffset: number;
  lineBuffer: string;
  activeToolIds: Set<string>;
  activeToolStatuses: Map<string, string>;
  activeToolNames: Map<string, string>;
  activeSubagentToolIds: Map<string, Set<string>>; // parentToolId → active sub-tool IDs
  activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId → (subToolId → toolName)
  backgroundAgentToolIds: Set<string>; // tool IDs for run_in_background Agent calls (stay alive until queue-operation)
  isWaiting: boolean;
  /** When the current wait began (ms since epoch) -- the turn-end record's
   *  timestamp when known, so a conversation found hours later says so. */
  waitingSince?: number;
  /** First line of the user's latest prompt -- what the conversation is about,
   *  for an inbox that has to remind you why you opened it. */
  lastPrompt?: string;
  /** Permission mode the session last recorded (`default`, `auto`, `plan`, ...). */
  permissionMode?: string;
  permissionSent: boolean;
  hadToolsInTurn: boolean;
  /** Directory name — the agent's origin label (only set for multi-root workspaces) */
  directoryName?: string;
  /** Timestamp of last JSONL data received (ms since epoch) */
  lastDataAt: number;
  /** Total JSONL lines processed for this agent */
  linesProcessed: number;
  /** Set of record.type values we've already warned about (prevents log spam) */
  seenUnknownRecordTypes: Set<string>;
  /** Whether a hook event has been delivered for this agent (suppresses heuristic timers) */
  hookDelivered: boolean;
  /** True when agent has no transcript file (provider doesn't use JSONL). All state from hooks. */
  hooksOnly?: boolean;
  /** Provider that created this agent (defaults to 'claude') */
  providerId?: string;
  /** Set when SessionEnd(reason=clear) fires; cleared when SessionStart(source=clear) reassigns */
  pendingClear?: boolean;
  /** Hook-generated tool ID for PreToolUse/PostToolUse correlation */
  currentHookToolId?: string;
  /** Tool name from the most recent PreToolUse, used to correlate a later SubagentStart
   *  event with the parent tool that launched it. */
  currentHookToolName?: string;
  /** True if the CURRENT PreToolUse tool call is a teammate spawn (per the provider's
   *  `team.isTeammateSpawnCall`). Authoritative source for teammate vs basic-subagent
   *  routing in SubagentStart. Set in PreToolUse, NOT cleared in PostToolUse (survives
   *  the PostToolUse-before-SubagentStart race); overwritten on the next PreToolUse. */
  currentHookIsTeammateSpawn?: boolean;

  // -- Context window usage (server/src/contextUsage.ts) --
  /** Tokens in the agent's context as of its newest turn; 0 until one is seen.
   *  A snapshot, not a running total -- it falls on compaction and /clear. */
  contextTokens: number;
  /** Observational estimate of the window `contextTokens` fits in. Widens as
   *  larger contexts appear, never shrinks. */
  maxContextTokens: number;
  /** True once this transcript produced a main-chain turn, after which
   *  sidechain records belong to sub-agents and stop moving the gauge. */
  sawMainChainUsage?: boolean;
  /** Tokens this conversation has spent, summed over every response -- unlike
   *  contextTokens this only grows. */
  totalTokens?: number;
  /** totalTokens split by usage counter, plus what it would cost at API list
   *  prices -- the counters are priced up to ~100x apart. costUsd is null once
   *  any response came from a model the provider can't price. */
  spend?: TokenSpend;
  /** message.ids of the responses most recently counted into totalTokens (one
   *  response is split over several records that repeat its usage, and
   *  sub-agent records interleave with them). Bounded, oldest first. */
  recentUsageMessageIds?: string[];

  // -- Agent Teams --
  teamName?: string;
  agentName?: string;
  /** True when teamName was read from the session's own record tags (tmux/
   *  inline teams, teammate sessions). Tag identity is authoritative: spawn-
   *  result re-latching (implicit-team generations on resume) only applies to
   *  tag-less leads. Transient — not persisted. */
  teamNameFromTags?: boolean;
  isTeamLead?: boolean;
  leadAgentId?: number;
  /** True when lead spawns teammates via tmux (run_in_background Agent calls) */
  teamUsesTmux?: boolean;
  /** For a promoted anonymous background agent (teams OFF): the lead's Agent
   *  tool_use id that spawned it. Links this character to the lead's
   *  backgroundAgentToolIds entry so the queue-operation completion removes it. */
  spawnToolUseId?: string;
  /** Tool ids of spawn calls whose input carried a `name` — teammates-to-be.
   *  Every agentToolStart (re-)broadcast for these carries isTeammateSpawn so
   *  the webview never creates a Subtask ghost for them. Transient, lazily
   *  created, never persisted. */
  teammateSpawnToolIds?: Set<string>;

  // -- Avatar customization --
  /** Preferred character palette (0-5). If undefined, auto-assigned for diversity. */
  palette?: number;
  /** Hue shift in degrees (0-360). Rotates the base palette colors. */
  hueShift?: number;
}

export interface PersistedAgent {
  id: number;
  sessionId?: string;
  /** Terminal name — empty string for extension panel sessions */
  terminalName: string;
  /** Whether this agent was detected from an external source */
  isExternal?: boolean;
  jsonlFile: string;
  projectDir: string;
  /** Directory name — the agent's origin label (only set for multi-root workspaces) */
  directoryName?: string;
  /** Pre-Directory spelling of `directoryName`, written by releases up to
   *  v1.4.x. Read as a fallback on restore so an upgrade doesn't strip the
   *  label (and the Area-mapping key) off every agent from the previous
   *  session; never written — the next persist rewrites it as directoryName. */
  folderName?: string;

  // -- Agent Teams --
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
  /** Live background-spawn tool ids on a lead. Persisted so the spawns'
   *  transcripts are re-adopted after a reload; the spawned children
   *  themselves are derived state and never persisted. */
  backgroundAgentToolIds?: string[];
  /** Preferred character palette (0-5). Persisted so colors stay stable
   *  across server restarts; assignPaletteIfNeeded is a no-op on restore. */
  palette?: number;
  /** Hue shift in degrees (0-360). Persisted alongside palette. */
  hueShift?: number;
}
