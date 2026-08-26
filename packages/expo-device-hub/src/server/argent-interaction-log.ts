import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type AgentInteraction } from '@expo/hub-client';

import { parseArgentInteractionLogLine } from './argent-interaction-parser';

export const DEFAULT_ARGENT_MCP_LOG = join(homedir(), '.argent', 'mcp-calls.log');

/** Incrementally reads complete JSONL records from Argent's append-only MCP log. */
export class ArgentInteractionLog {
  readonly #path: string;
  #offset = 0;
  #remainder = '';

  constructor(path = process.env.ARGENT_MCP_LOG ?? DEFAULT_ARGENT_MCP_LOG) {
    this.#path = path;
  }

  async read(): Promise<AgentInteraction[]> {
    let size: number;
    try {
      size = (await stat(this.#path)).size;
    } catch {
      return [];
    }

    if (size < this.#offset) {
      this.#offset = 0;
      this.#remainder = '';
    }
    if (size === this.#offset) return [];

    const chunk = await readUtf8Range(this.#path, this.#offset, size - 1);
    this.#offset = size;
    const lines = `${this.#remainder}${chunk}`.split('\n');
    this.#remainder = lines.pop() ?? '';
    return lines
      .map(parseArgentInteractionLogLine)
      .filter((interaction): interaction is AgentInteraction => interaction !== null);
  }
}

async function readUtf8Range(path: string, start: number, end: number): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path, { start, end })) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
