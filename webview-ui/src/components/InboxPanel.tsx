import { useEffect, useRef, useState } from 'react';

import type { AgentContextUsage, PlanUsage, PlanUsageWindow } from '../../../core/src/messages.js';
import { INBOX_CLOCK_TICK_MS, INBOX_SEEN_MAX, INBOX_SEEN_STORAGE_KEY } from '../constants.js';
import type { WaitingInfo } from '../hooks/useExtensionMessages.js';
import type { ToolActivity } from '../office/types.js';
import { Button } from './ui/Button.js';

/**
 * Every conversation at a glance, most urgent first: the ones waiting on an
 * approval, then the ones that answered and are waiting on you, then the ones
 * still working. Plus the account's plan limits. The office shows the same
 * agents as characters; this is the list you scan when you've lost track.
 */
interface InboxPanelProps {
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  waitingInfo: Record<number, WaitingInfo>;
  tokenSpend: Record<number, AgentContextUsage>;
  planUsage: PlanUsage | null;
  folderNameOf: (id: number) => string | undefined;
  /** The character's own active flag -- the one its "Idle" label reads. */
  isActive: (id: number) => boolean;
  onSelect: (id: number) => void;
  /** A seen wait: take it out of the office if that's safe (see canSendOffOnSeen). */
  onDismiss: (id: number) => void;
  /** Distance from the right edge, in px: clears the desktop agent-card bar. */
  rightPx: number;
}

type RowKind = 'approval' | 'waiting' | 'working' | 'idle';

interface Row {
  id: number;
  kind: RowKind;
  folder: string;
  detail: string;
  since?: number;
  spend?: AgentContextUsage;
  seenKey?: string;
}

const KIND_ORDER: Record<RowKind, number> = { approval: 0, waiting: 1, working: 2, idle: 3 };
const KIND_ICON: Record<RowKind, string> = {
  approval: '⚠',
  waiting: '✓',
  working: '…',
  idle: '·',
};
const KIND_CLASS: Record<RowKind, string> = {
  approval: 'text-status-permission',
  waiting: 'text-status-success',
  working: 'text-status-active',
  idle: 'text-text-muted',
};
const BASE_TITLE = 'Pixel Agents';

// Seen marks live in this browser: "seen" is about the person looking, and a
// wait that moves on gets a new key, so a stale mark never hides news. The
// server forgets dismissals when it restarts; these marks dismiss again.
// ponytail: a restart briefly spawns then despawns seen characters; persist
// dismissals server-side if that flash ever matters.
function loadSeen(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(INBOX_SEEN_STORAGE_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function saveSeen(keys: string[]): void {
  try {
    localStorage.setItem(INBOX_SEEN_STORAGE_KEY, JSON.stringify(keys.slice(-INBOX_SEEN_MAX)));
  } catch {
    // private window / blocked storage: marks just won't survive a reload
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Cost when the model could be priced, else the raw token total. */
function formatSpend(u: AgentContextUsage): string {
  if (u.costUsd !== undefined) return `$${u.costUsd.toFixed(u.costUsd < 10 ? 2 : 0)}`;
  return formatTokens(u.totalTokens ?? 0);
}

/** Where the spend went: the counters are priced up to ~100x apart. */
function spendBreakdown(u: AgentContextUsage): string {
  const lines = [
    `Entrada: ${formatTokens(u.inputTokens ?? 0)}`,
    `Cache (escrita): ${formatTokens(u.cacheWriteTokens ?? 0)}`,
    `Cache (leitura): ${formatTokens(u.cacheReadTokens ?? 0)}`,
    `Saída: ${formatTokens(u.outputTokens ?? 0)}`,
    `Total: ${formatTokens(u.totalTokens ?? 0)} tokens`,
  ];
  lines.push(
    u.costUsd !== undefined
      ? `≈ US$ ${u.costUsd.toFixed(2)} a preço de API`
      : 'Custo: modelo sem preço conhecido',
  );
  return lines.join('\n');
}

function formatAge(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `há ${h}h` : `há ${Math.floor(h / 24)}d`;
}

function formatResetIn(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${min % 60}m` : `${min}m`;
}

function windowLabel(w: PlanUsageWindow): string {
  if (w.kind === 'session') return '5h';
  return w.model ? `Semanal · ${w.model}` : 'Semanal';
}

function barClass(percent: number): string {
  if (percent >= 95) return 'bg-danger';
  if (percent >= 80) return 'bg-warning';
  return 'bg-accent';
}

export function InboxPanel({
  agents,
  agentTools,
  waitingInfo,
  tokenSpend,
  planUsage,
  folderNameOf,
  isActive,
  onSelect,
  onDismiss,
  rightPx,
}: InboxPanelProps) {
  const [now, setNow] = useState(() => Date.now());
  const [seen, setSeen] = useState(loadSeen);
  const dismissedIds = useRef(new Set<number>());
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [notifyPermission, setNotifyPermission] = useState(() =>
    typeof Notification === 'undefined' ? 'denied' : Notification.permission,
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), INBOX_CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const rows: Row[] = agents.map((id) => {
    const folder = folderNameOf(id) ?? `#${id}`;
    const tools = agentTools[id] ?? [];
    const pending = tools.find((t) => t.permissionWait && !t.done);
    const wait = waitingInfo[id];
    const spend = tokenSpend[id];
    if (pending) return { id, kind: 'approval', folder, detail: pending.status, spend };
    if (wait) {
      return {
        id,
        kind: 'waiting',
        folder,
        detail: wait.prompt ?? '',
        since: wait.since,
        spend,
        seenKey: `${folder}|${wait.since}`,
      };
    }
    const running = tools.find((t) => !t.done);
    // Neither waiting nor doing anything: say so, rather than a "working" row
    // that hides whatever left it in that state.
    if (!running && !isActive(id)) return { id, kind: 'idle', folder, detail: 'parado', spend };
    return { id, kind: 'working', folder, detail: running?.status ?? '', spend };
  });
  rows.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (b.since ?? 0) - (a.since ?? 0));

  const seenSet = new Set(seen);
  const isSeen = (r: Row) => r.seenKey !== undefined && seenSet.has(r.seenKey);
  const visible = rows.filter((r) => !isSeen(r));
  const approvals = rows.filter((r) => r.kind === 'approval').length;
  const unread = visible.filter((r) => r.kind === 'waiting').length;

  // A seen wait still in the office (marked a moment ago, or re-found after a
  // server restart): send it off, once per agent.
  const seenIds = rows.filter(isSeen).map((r) => r.id);
  useEffect(() => {
    // Forget agents no longer in a seen wait (gone, or moved on): a later seen
    // wait, or the same id coming back, gets sent off again.
    for (const id of dismissedIds.current) {
      if (!seenIds.includes(id)) dismissedIds.current.delete(id);
    }
    for (const id of seenIds) {
      if (dismissedIds.current.has(id)) continue;
      dismissedIds.current.add(id);
      onDismiss(id);
    }
  });

  useEffect(() => {
    document.title = approvals > 0 ? `(${approvals}) ${BASE_TITLE}` : BASE_TITLE;
  }, [approvals]);

  const markSeen = (key: string) => {
    const next = [...seen, key];
    setSeen(next);
    saveSeen(next);
  };

  const toggleExpanded = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  const askNotify = () => {
    void Notification.requestPermission().then(setNotifyPermission);
  };

  return (
    <div
      style={{ right: rightPx }}
      className="absolute top-8 z-20 pixel-panel font-ui-all p-10 w-[400px] max-h-[80vh] flex flex-col gap-8 text-[14px] leading-snug"
    >
      <div className="flex items-center gap-8">
        <span className="flex-1 font-semibold text-[15px]">
          Caixa de entrada
          {approvals > 0 && <span className="text-status-permission"> · {approvals} ⚠</span>}
          {unread > 0 && <span className="text-status-success"> · {unread} ✓</span>}
        </span>
        {notifyPermission === 'default' && (
          <Button
            size="sm"
            variant="ghost"
            className="text-[13px]!"
            onClick={askNotify}
            title="Notificar aprovações"
          >
            🔔 Ativar alertas
          </Button>
        )}
      </div>

      {planUsage && (
        <div className="flex flex-col gap-4">
          {planUsage.windows.length === 0 && (
            <span className="text-text-muted">Limites do plano indisponíveis</span>
          )}
          {planUsage.windows.map((w) => (
            <div key={`${w.kind}:${w.model ?? ''}`} className="flex items-center gap-6">
              <span className="w-[130px] truncate">{windowLabel(w)}</span>
              <div className="flex-1 h-10 border-2 border-border bg-bg-dark">
                <div
                  className={`h-full ${barClass(w.percent)}`}
                  style={{ width: `${Math.min(100, w.percent)}%` }}
                />
              </div>
              <span className="w-[40px] text-right tabular-nums">{Math.round(w.percent)}%</span>
              {w.resetsAt !== undefined && (
                <span className="w-[60px] text-right text-text-muted text-[12px]">
                  {formatResetIn(w.resetsAt - now)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2 overflow-y-auto">
        {visible.length === 0 && (
          <span className="text-text-muted">
            {rows.length === 0
              ? 'Nenhuma conversa. Ative "Watch All Sessions" nas configurações.'
              : 'Tudo em dia.'}
          </span>
        )}
        {visible.map((r) => {
          const open = expanded.has(r.id);
          return (
            <div
              key={r.id}
              className="flex items-start gap-6 p-4 hover:bg-btn-hover cursor-pointer"
              onClick={() => onSelect(r.id)}
            >
              <button
                className="w-16 shrink-0 text-text-muted cursor-pointer bg-transparent border-0 p-0"
                aria-expanded={open}
                aria-label={open ? 'Recolher detalhes' : 'Expandir detalhes'}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpanded(r.id);
                }}
              >
                {open ? '▾' : '▸'}
              </button>
              <span className={`w-12 shrink-0 ${KIND_CLASS[r.kind]}`}>{KIND_ICON[r.kind]}</span>
              <div className="flex-1 min-w-0">
                <div className="flex gap-6">
                  <span className="flex-1 truncate font-medium">{r.folder}</span>
                  {r.since !== undefined && (
                    <span className="text-text-muted text-[12px]">{formatAge(now - r.since)}</span>
                  )}
                  {r.spend && (
                    <span className="text-text-muted text-[12px] tabular-nums">
                      {formatSpend(r.spend)}
                    </span>
                  )}
                </div>
                {r.detail && (
                  <div
                    className={`text-text-muted text-[12px] ${open ? 'whitespace-pre-wrap break-words' : 'truncate'}`}
                  >
                    {r.detail}
                  </div>
                )}
                {open && r.spend && (
                  <div className="mt-4 text-text-muted text-[12px] whitespace-pre-line tabular-nums">
                    {spendBreakdown(r.spend)}
                  </div>
                )}
              </div>
              {r.seenKey && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-[13px]! shrink-0"
                  title="Já vi: tira do escritório até ter novidade"
                  onClick={(e) => {
                    e.stopPropagation();
                    markSeen(r.seenKey!);
                  }}
                >
                  visto
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
