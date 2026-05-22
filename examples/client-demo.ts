/**
 * Reference MCP client that drives the full BTX admission flow against the
 * companion stdio-server.ts:
 *
 *   1. tools/list — discover available tools
 *   2. tools/call expensive_search — without btx_proof → isError with challenge
 *   3. Solver.solve(challenge, { mode: 'pure-js' }) → produce nonce + digest
 *   4. tools/call expensive_search — with btx_proof populated → success
 *
 * Run (after `pnpm example:server` is running in another shell — actually no,
 * this script spawns its own server via StdioClientTransport): `pnpm example:client`
 *
 * Environment (same as stdio-server.ts; client passes them to the spawned server):
 *   BTX_RPC_URL, BTX_RPC_AUTH
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import { Solver, type Challenge } from '@btx-tools/challenges-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Audit LOW: import the marker from the package root (the canonical public
// surface), not from src/wrapper.js (internal path). Adopters who copy this
// example as their integration template should see the public import path.
import { BTX_CHALLENGE_MARKER } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_PATH = resolvePath(__dirname, 'stdio-server.ts');

function ms(start: number): string {
  return `${((Date.now() - start) / 1000).toFixed(2)}s`;
}

interface CallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function parseChallengeEnvelope(callResult: CallResult): Challenge {
  const textContent = callResult.content.find((c) => c.type === 'text');
  if (!textContent?.text) {
    throw new Error(`isError result has no text content: ${JSON.stringify(callResult)}`);
  }
  let parsed: { marker?: string; challenge?: unknown };
  try {
    parsed = JSON.parse(textContent.text);
  } catch (err) {
    throw new Error(`text content is not valid JSON: ${textContent.text.slice(0, 200)}`);
  }
  if (parsed.marker !== BTX_CHALLENGE_MARKER) {
    throw new Error(
      `isError result is not a BTX admission challenge (marker=${parsed.marker}). Full body: ${textContent.text.slice(0, 400)}`,
    );
  }
  // Audit LOW: null-check the challenge field before casting. A hostile or
  // buggy server could return `{ marker, challenge: null }` and we'd pass
  // null deep into Solver.solve where it crashes cryptically.
  if (
    parsed.challenge === null ||
    parsed.challenge === undefined ||
    typeof parsed.challenge !== 'object' ||
    typeof (parsed.challenge as { challenge_id?: unknown }).challenge_id !== 'string'
  ) {
    throw new Error(
      `BTX admission challenge envelope has no valid 'challenge' field. Full body: ${textContent.text.slice(0, 400)}`,
    );
  }
  return parsed.challenge as Challenge;
}

async function main(): Promise<void> {
  if (!process.env.BTX_RPC_URL || !process.env.BTX_RPC_AUTH) {
    console.error('error: set BTX_RPC_URL and BTX_RPC_AUTH');
    process.exit(1);
  }

  // Audit LOW: don't hardcode `command: 'tsx'` — it relies on tsx being on
  // PATH. Use the current Node binary + the package-local tsx loader path.
  // This works whether tsx is global, in node_modules/.bin, or via a pnpm
  // run env. Falls back to plain 'tsx' if package-local path isn't found.
  const tsxBin = resolvePath(__dirname, '..', 'node_modules', '.bin', 'tsx');
  console.log('[client] spawning stdio-server.ts as child process...');
  const transport = new StdioClientTransport({
    command: tsxBin,
    args: [SERVER_PATH],
    env: { ...process.env } as Record<string, string>,
  });

  const client = new Client(
    { name: 'btx-mcp-gateway-client-demo', version: '0.1.0' },
    { capabilities: {} },
  );

  await client.connect(transport);
  console.log('[client] connected');

  console.log('[client] listing tools...');
  const toolsList = await client.listTools();
  console.log(
    `[client] server exposes ${toolsList.tools.length} tool(s): ${toolsList.tools.map((t) => t.name).join(', ')}`,
  );

  console.log('[client] calling expensive_search WITHOUT proof...');
  const t0 = Date.now();
  const noProofResult = (await client.callTool({
    name: 'expensive_search',
    arguments: { query: 'BTX service challenges' },
  })) as CallResult;
  console.log(`[client] first call returned isError=${noProofResult.isError} in ${ms(t0)}`);

  if (!noProofResult.isError) {
    console.error('[client] expected isError on first call; got success — gate may be misconfigured');
    process.exit(2);
  }

  const challenge = parseChallengeEnvelope(noProofResult);
  console.log(
    `[client] received challenge_id=${(challenge as { challenge_id: string }).challenge_id.slice(0, 16)}...`,
  );

  console.log('[client] solving challenge (pure-JS — may take minutes at non-floor difficulty)...');
  const t1 = Date.now();
  const proof = await Solver.solve(challenge, { mode: 'pure-js' });
  console.log(
    `[client] solved in ${ms(t1)}: nonce=${proof.nonce64_hex} digest=${proof.digest_hex.slice(0, 16)}...`,
  );

  console.log('[client] retrying expensive_search WITH proof...');
  const t2 = Date.now();
  const admittedResult = (await client.callTool({
    name: 'expensive_search',
    arguments: {
      query: 'BTX service challenges',
      btx_proof: {
        challenge,
        nonce64_hex: proof.nonce64_hex,
        digest_hex: proof.digest_hex,
      },
    },
  })) as CallResult;
  console.log(`[client] second call returned isError=${admittedResult.isError} in ${ms(t2)}`);
  if (admittedResult.isError) {
    console.error('[client] expected success on retry; got isError');
    console.error(admittedResult);
    process.exit(2);
  }

  const resultText = admittedResult.content[0]?.text ?? '<no text>';
  console.log('[client] tool result:');
  console.log(resultText);

  await client.close();
  console.log('[client] done');
}

main().catch((err) => {
  console.error('client failed:', err);
  process.exit(1);
});
