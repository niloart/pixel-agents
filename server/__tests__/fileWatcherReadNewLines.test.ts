import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ window: { activeTerminal: undefined, terminals: [] } }));

const processed: string[] = [];
vi.mock('../src/transcriptParser.js', () => ({
  getHookProvider: () => null,
  processTranscriptLine: (_id: number, line: string) => processed.push(line),
}));

import { AgentStateStore } from '../src/agentStateStore.js';
import { readNewLines } from '../src/fileWatcher.js';
import type { AgentState } from '../src/types.js';

describe('readNewLines', () => {
  let tmpDir: string;
  let file: string;
  let agents: AgentStateStore;

  beforeEach(() => {
    processed.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-fw-read-'));
    file = path.join(tmpDir, 'sess.jsonl');
    fs.writeFileSync(file, '');
    agents = new AgentStateStore();
    agents.set(1, { id: 1, jsonlFile: file, fileOffset: 0, lineBuffer: '' } as AgentState);
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const read = () => readNewLines(1, agents, new Map(), new Map());

  it('decodes a multi-byte char split across two reads intact', () => {
    const line = Buffer.from('{"text":"ação 🎉"}\n', 'utf-8');
    const split = line.indexOf(Buffer.from('🎉', 'utf-8')) + 2; // mid-emoji
    fs.appendFileSync(file, line.subarray(0, split));
    read();
    fs.appendFileSync(file, line.subarray(split));
    read();
    expect(processed).toEqual(['{"text":"ação 🎉"}']);
    expect(agents.get(1)!.fileOffset).toBe(line.length);
  });

  it('catches up on more than one chunk in a single call', () => {
    const record = `{"pad":"${'x'.repeat(1000)}"}\n`;
    fs.writeFileSync(file, record.repeat(2000)); // ~2MB, past one 1MB chunk
    read();
    expect(processed).toHaveLength(2000);
  });
});
