import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { PlanUsage, PlanUsageWindow } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { PLAN_USAGE_POLL_MS, PLAN_USAGE_URL } from './constants.js';

/**
 * The account's plan limits (5-hour, weekly, per-model weekly) -- what Claude's
 * own usage card shows. Transcripts and hooks never carry them, so this asks
 * the endpoint the Claude apps use, with the OAuth login Claude Code keeps in
 * ~/.claude/.credentials.json (re-read every poll: the CLI refreshes it).
 *
 * ponytail: undocumented endpoint. When it moves, the bars read "unavailable"
 * and nothing else breaks; switch to an official source if one ships.
 */
interface RawLimit {
  kind?: string;
  group?: string;
  percent?: number;
  resets_at?: string;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

export function toWindows(limits: RawLimit[] | undefined): PlanUsageWindow[] {
  const windows: PlanUsageWindow[] = [];
  for (const l of limits ?? []) {
    if (typeof l.percent !== 'number') continue;
    const model = l.scope?.model?.display_name ?? undefined;
    const kind =
      l.kind === 'session' ? 'session' : model ? 'weekly_model' : (l.group ?? l.kind ?? '');
    windows.push({
      kind,
      model,
      percent: l.percent,
      resetsAt: Date.parse(l.resets_at ?? '') || undefined,
    });
  }
  return windows;
}

async function readPlanUsage(): Promise<PlanUsage> {
  try {
    const credsFile = path.join(os.homedir(), '.claude', '.credentials.json');
    const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8')) as {
      claudeAiOauth?: { accessToken?: string };
    };
    const token = creds.claudeAiOauth?.accessToken;
    if (!token) return { type: 'planUsage', windows: [], error: 'not logged in' };
    const res = await fetch(PLAN_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    });
    if (!res.ok) return { type: 'planUsage', windows: [], error: `HTTP ${res.status}` };
    const body = (await res.json()) as { limits?: RawLimit[] };
    return { type: 'planUsage', windows: toWindows(body.limits) };
  } catch (err) {
    return {
      type: 'planUsage',
      windows: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

let latest: PlanUsage | null = null;

/** Newest reading, for clients that connect between polls. */
export function getLatestPlanUsage(): PlanUsage | null {
  return latest;
}

export function startPlanUsagePolling(store: AgentStateStore): () => void {
  const poll = async (): Promise<void> => {
    latest = await readPlanUsage();
    store.broadcast({ ...latest });
  };
  void poll();
  const timer = setInterval(() => void poll(), PLAN_USAGE_POLL_MS);
  return () => clearInterval(timer);
}
