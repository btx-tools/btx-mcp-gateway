/**
 * End-to-end integration test using InMemoryTransport — wires a client and
 * server in the same process and exercises the full BTX admission flow
 * (tools/list, tools/call without proof → challenge, tools/call with proof
 * → success, replay → 403-equivalent).
 *
 * Mocks BtxChallengeClient so the test doesn't need a live btxd. The unit
 * test (`tests/unit/wrapper.test.ts`) already covers the wrapper's internal
 * logic; this test focuses on the wire shape over the MCP transport.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type {
  BtxChallengeClient,
  Challenge,
} from '@btx-tools/challenges-sdk';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createBtxMcpServer } from '../../src/server.js';
import {
  btxToolWrapper,
  BTX_CHALLENGE_MARKER,
  BTX_ADMISSION_FAILED_MARKER,
} from '../../src/wrapper.js';

const STUB_CHALLENGE: Challenge = {
  challenge_id: 'integration-test-challenge-id',
  issued_at: 1716423000,
  expires_at: 1716426600,
  expires_in_s: 3600,
  binding: {
    chain: 'btx-mainnet',
    purpose: 'agent_tool_call',
    resource: 'tool:test',
    subject: 'anonymous',
    resource_hash: 'aa',
    subject_hash: 'bb',
    salt: 'cc',
    anchor_height: 108700,
    anchor_hash: 'dd',
  },
  proof_policy: {
    verification_rule: 'matmul-v1',
    sigma_gate_applied: true,
    expiration_enforced: true,
    challenge_id_required: true,
    replay_protection: 'redeem-once',
    redeem_rpc: 'redeemmatmulserviceproof',
    solve_rpc: 'solvematmulservicechallenge',
    locally_issued_required: true,
  },
  challenge: {
    chain: 'btx-mainnet',
    algorithm: 'matmul-v1',
    height: 108700,
    previousblockhash: 'ee',
    mintime: 1716422940,
    bits: '1a0fffff',
    difficulty: 0.0001,
    target: 'ffff',
    noncerange: '0-ff',
    header_context: {
      version: 1,
      previousblockhash: 'ee',
      merkleroot: 'ff',
      time: 1716423000,
      bits: '1a0fffff',
      nonce64_start: 0,
      matmul_dim: 512,
      seed_a: '00',
      seed_b: '11',
    },
    matmul: {
      n: 512,
      b: 8,
      r: 4,
      q: 2147483647,
      min_dimension: 64,
      max_dimension: 512,
      seed_a: '00',
      seed_b: '11',
    },
  },
};

interface RedeemBehavior {
  callCount: number;
  alwaysValid?: boolean;
  rejectAfterFirst?: boolean; // simulate already_redeemed on second call
}

function buildClient(redeemBehavior: RedeemBehavior): BtxChallengeClient {
  return {
    issue: async () => STUB_CHALLENGE,
    redeem: async () => {
      redeemBehavior.callCount += 1;
      if (redeemBehavior.rejectAfterFirst && redeemBehavior.callCount > 1) {
        return { valid: false, reason: 'already_redeemed' };
      }
      return { valid: true, reason: 'ok', redeemed: true };
    },
    verify: async () => ({ valid: false, reason: 'invalid_proof' }),
    solve: async () => ({ nonce64_hex: 'aa', digest_hex: 'bb', proof: {} }),
    verifyBatch: async () => ({ count: 0, valid: 0, invalid: 0, by_reason: {}, results: [] }),
    redeemBatch: async () => ({ count: 0, valid: 0, invalid: 0, by_reason: {}, results: [] }),
    call: async () => ({}),
  } as unknown as BtxChallengeClient;
}

async function wireClientServer(redeemBehavior: RedeemBehavior): Promise<Client> {
  const btxClient = buildClient(redeemBehavior);
  const server = createBtxMcpServer({
    name: 'integration-test',
    version: '0.0.0',
    tools: [
      btxToolWrapper({
        name: 'test_search',
        description: 'integration test tool',
        inputSchema: { query: z.string() },
        handler: async ({ query }) => ({
          content: [{ type: 'text', text: `searched: ${query}` }],
        }),
        gate: {
          client: btxClient,
          purpose: 'agent_tool_call',
          resource: 'tool:test_search',
          subject: 'test',
          issueParams: { target_solve_time_s: 0.001 },
        },
      }),
    ],
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: 'integration-test-client', version: '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return client;
}

interface CallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

describe('end-to-end MCP flow with BTX admission', () => {
  it('tools/list exposes the wrapped tool', async () => {
    const client = await wireClientServer({ callCount: 0 });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('test_search');
    const tool = tools.find((t) => t.name === 'test_search')!;
    // The wrapper injects btx_proof into inputSchema
    const schema = tool.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties).toHaveProperty('query');
    expect(schema.properties).toHaveProperty('btx_proof');
    await client.close();
  });

  it('tools/call without btx_proof returns isError with challenge envelope', async () => {
    const client = await wireClientServer({ callCount: 0 });
    const result = (await client.callTool({
      name: 'test_search',
      arguments: { query: 'hello' },
    })) as CallResult;
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text;
    expect(text).toBeDefined();
    const parsed = JSON.parse(text!);
    expect(parsed.marker).toBe(BTX_CHALLENGE_MARKER);
    expect(parsed.challenge.challenge_id).toBe(STUB_CHALLENGE.challenge_id);
    expect(parsed.do_not_auto_retry).toBeDefined();
    await client.close();
  });

  it('tools/call with valid btx_proof admits and returns the handler result', async () => {
    const client = await wireClientServer({ callCount: 0 });
    const result = (await client.callTool({
      name: 'test_search',
      arguments: {
        query: 'hello',
        btx_proof: {
          challenge: STUB_CHALLENGE,
          nonce64_hex: 'abcdef0123456789',
          digest_hex: 'a'.repeat(64),
        },
      },
    })) as CallResult;
    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text;
    expect(text).toBe('searched: hello');
    await client.close();
  });

  it('replay (second call with same proof) returns admission_failed marker', async () => {
    const behavior: RedeemBehavior = { callCount: 0, rejectAfterFirst: true };
    const client = await wireClientServer(behavior);
    const proof = {
      challenge: STUB_CHALLENGE,
      nonce64_hex: 'aa',
      digest_hex: 'bb',
    };

    const first = (await client.callTool({
      name: 'test_search',
      arguments: { query: 'first', btx_proof: proof },
    })) as CallResult;
    expect(first.isError).toBeFalsy();

    const second = (await client.callTool({
      name: 'test_search',
      arguments: { query: 'second', btx_proof: proof },
    })) as CallResult;
    expect(second.isError).toBe(true);
    const parsed = JSON.parse(second.content[0]!.text!);
    expect(parsed.marker).toBe(BTX_ADMISSION_FAILED_MARKER);
    expect(parsed.reason).toBe('already_redeemed');
    await client.close();
  });
});
