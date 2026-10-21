/**
 * Whether the inbox's "seen" may send the agent off the office (closeAgent). Only
 * for agents with no terminal: closeAgent disposes a terminal-backed agent's
 * terminal, killing the conversation. In VS Code that is every non-headless agent
 * (headless = adopted from outside); in standalone it is an agent with a live
 * embedded terminal. Everyone else just loses the row.
 */
export function canSendOffOnSeen(
  ch: { isHeadless?: boolean } | undefined,
  browserRuntime: boolean,
  hasEmbeddedTerminal: boolean,
): boolean {
  if (ch === undefined) return false;
  return browserRuntime ? !hasEmbeddedTerminal : ch.isHeadless === true;
}
