import { describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { updateContextUsage } from '../src/contextUsage.js';
import type { AgentState } from '../src/types.js';

const record = (id: string, isSidechain: boolean) => ({
  type: 'assistant',
  isSidechain,
  message: { id, usage: { input_tokens: 10 } },
});

describe('conversation spend', () => {
  it('counts each response once when sub-agent records interleave with it', () => {
    const agents = new AgentStateStore();
    const agent = { id: 1, contextTokens: 0, maxContextTokens: 0 } as AgentState;
    agents.set(1, agent);
    const sent: unknown[] = [];
    agents.on('broadcast', (msg) => sent.push(msg));

    // main A, sub X, main A again, sub X again: two responses, not four.
    for (const [id, side] of [
      ['A', false],
      ['X', true],
      ['A', false],
      ['X', true],
    ] as const) {
      updateContextUsage(1, agent, agents, record(id, side));
    }

    expect(agent.totalTokens).toBe(20);
    // The repeated sidechain record changed nothing, so it broadcast nothing.
    expect(sent).toHaveLength(3);
  });
});
