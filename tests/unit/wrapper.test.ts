/**
 * Unit tests for btxToolWrapper. Mocks BtxChallengeClient so we don't need a
 * live btxd. Verifies the gate's issue/redeem/admit flow shape in isolation.
 *
 * Pattern lifted from @btx-tools/middleware-express's tests — same mocking
 * approach (no msw needed; we directly stub the client methods).
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type {
  BtxChallengeClient,
  Challenge,
  VerifyResult,
} from '@btx-tools/challenges-sdk';

import {
  btxToolWrapper,
  BTX_CHALLENGE_MARKER,
  BTX_ADMISSION_FAILED_MARKER,
} from '../../src/wrapper.js';

// Minimal stub challenge — matches the wire shape we serialize back to the client.
const STUB_CHALLENGE: Challenge = {
  challenge_id: 'test-challenge-id-1234567890abcdef',
  issued_at: 1716423000,
  expires_at: 1716426600,
  expires_in_s: 3600,
  binding: {
    chain: 'btx-mainnet',
    purpose: 'agent_tool_call',
    resource: 'tool:test',
    subject: 'anonymous_agent',
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
    noncerange: '0000000000000000-ffffffffffffffff',
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

function mockClient(overrides: Partial<{
  issue: () => Promise<Challenge>;
  redeem: () => Promise<VerifyResult>;
}> = {}): BtxChallengeClient {
  return {
    issue: vi.fn(overrides.issue ?? (async () => STUB_CHALLENGE)),
    redeem: vi.fn(overrides.redeem ?? (async () => ({ valid: true, reason: 'ok', redeemed: true }))),
    verify: vi.fn(),
    solve: vi.fn(),
    verifyBatch: vi.fn(),
    redeemBatch: vi.fn(),
    call: vi.fn(),
  } as unknown as BtxChallengeClient;
}

function makeSampleTool(client: BtxChallengeClient) {
  return btxToolWrapper({
    name: 'test_search',
    description: 'test',
    inputSchema: {
      query: z.string(),
    },
    handler: async ({ query }) => ({
      content: [{ type: 'text', text: `result for: ${query}` }],
    }),
    gate: {
      client,
      purpose: 'agent_tool_call',
      resource: 'tool:test',
      subject: 'test_subject',
      issueParams: { target_solve_time_s: 0.001 },
    },
  });
}

describe('btxToolWrapper', () => {
  describe('without proof', () => {
    it('returns isError: true with the BTX challenge envelope marker', async () => {
      const client = mockClient();
      const tool = makeSampleTool(client);
      const result = await tool.callback({ query: 'hello' }, {} as never);
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      const text = (result.content[0] as { text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed.marker).toBe(BTX_CHALLENGE_MARKER);
      expect(parsed.challenge).toBeDefined();
      expect(parsed.challenge.challenge_id).toBe(STUB_CHALLENGE.challenge_id);
      expect(parsed.do_not_auto_retry).toBeDefined();
    });

    it('calls client.issue with the resolved purpose/resource/subject', async () => {
      const client = mockClient();
      const tool = btxToolWrapper({
        name: 'test',
        inputSchema: { q: z.string() },
        handler: async () => ({ content: [] }),
        gate: {
          client,
          purpose: 'rate_limit',
          resource: ({ q }) => `r:${q}`,
          subject: 'static_subject',
          issueParams: { target_solve_time_s: 0.001, expires_in_s: 60 },
        },
      });
      await tool.callback({ q: 'abc' }, {} as never);
      expect(client.issue).toHaveBeenCalledWith({
        purpose: 'rate_limit',
        resource: 'r:abc',
        subject: 'static_subject',
        target_solve_time_s: 0.001,
        expires_in_s: 60,
      });
    });

    it('returns sanitized isError if client.issue throws (stage=issue)', async () => {
      const client = mockClient({
        issue: async () => {
          throw new Error('connect ECONNREFUSED http://10.20.30.40:19332');
        },
      });
      const tool = makeSampleTool(client);
      const result = await tool.callback({ query: 'x' }, {} as never);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.btx_internal_error).toBe(true);
      expect(parsed.stage).toBe('issue');
      // Audit HIGH-1: the raw error message MUST NOT leak to the agent
      expect(parsed.message).not.toContain('ECONNREFUSED');
      expect(parsed.message).not.toContain('10.20.30.40');
    });

    it('fires onError hook with the raw error (issue stage)', async () => {
      const rawErr = new Error('btxd unreachable: http://10.20.30.40:19332');
      const client = mockClient({
        issue: async () => {
          throw rawErr;
        },
      });
      const onError = vi.fn();
      const tool = btxToolWrapper({
        name: 't',
        inputSchema: { q: z.string() },
        handler: async () => ({ content: [] }),
        gate: {
          client,
          purpose: 'p',
          resource: 'r',
          subject: 's',
          onError,
          issueParams: {},
        },
      });
      await tool.callback({ q: 'x' }, {} as never);
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0]![0]).toBe(rawErr);
    });

    it('issueParams cannot override the (purpose, resource, subject) binding', async () => {
      // Defense-in-depth (audit HIGH-2): even if a JS adopter or `as any`
      // bypass injects purpose/resource/subject into issueParams, the wrapper
      // must spread issueParams FIRST so the explicit fields win.
      const issueMock = vi.fn(async (_params: Record<string, unknown>) => STUB_CHALLENGE);
      const client = {
        issue: issueMock,
        redeem: vi.fn(async () => ({ valid: true, reason: 'ok', redeemed: true })),
        verify: vi.fn(),
        solve: vi.fn(),
        verifyBatch: vi.fn(),
        redeemBatch: vi.fn(),
        call: vi.fn(),
      } as unknown as BtxChallengeClient;
      const tool = btxToolWrapper({
        name: 't',
        inputSchema: { q: z.string() },
        handler: async () => ({ content: [] }),
        gate: {
          client,
          purpose: 'admission',
          resource: 'tool:safe',
          subject: 'tenant_42',
          // Hostile injection via TS bypass:
          issueParams: {
            purpose: 'unrestricted',
            resource: 'tool:dangerous',
            subject: 'tenant_admin',
          } as never,
        },
      });
      await tool.callback({ q: 'x' }, {} as never);
      const issueArg = issueMock.mock.calls[0]![0] as Record<string, unknown>;
      expect(issueArg.purpose).toBe('admission');
      expect(issueArg.resource).toBe('tool:safe');
      expect(issueArg.subject).toBe('tenant_42');
    });
  });

  describe('with proof', () => {
    const validProofArgs = {
      query: 'hello',
      btx_proof: {
        challenge: STUB_CHALLENGE,
        nonce64_hex: 'aabbccddeeff0011',
        digest_hex: 'a'.repeat(64),
      },
    };

    it('invokes the user handler on valid proof', async () => {
      const client = mockClient();
      const handler = vi.fn(
        async (_args: { query: string }, _extra: { btx: { result: VerifyResult } }) => ({
          content: [{ type: 'text' as const, text: `handled: ${_args.query}` }],
        }),
      );
      const tool = btxToolWrapper({
        name: 'test',
        inputSchema: { query: z.string() },
        handler,
        gate: {
          client,
          purpose: 'p',
          resource: 'r',
          subject: 's',
          issueParams: {},
        },
      });
      const result = await tool.callback(validProofArgs, {} as never);
      expect(result.isError).toBeUndefined();
      expect(handler).toHaveBeenCalledOnce();
      const call = handler.mock.calls[0]!;
      const [args, extra] = call;
      expect(args).toEqual({ query: 'hello' });
      expect((args as unknown as Record<string, unknown>).btx_proof).toBeUndefined();
      // The injected admission context
      expect(extra.btx.result.valid).toBe(true);
    });

    it('returns admission_failed marker on invalid proof', async () => {
      const client = mockClient({
        redeem: async () => ({
          valid: false,
          reason: 'invalid_proof',
        }),
      });
      const tool = makeSampleTool(client);
      const result = await tool.callback(validProofArgs, {} as never);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.marker).toBe(BTX_ADMISSION_FAILED_MARKER);
      expect(parsed.reason).toBe('invalid_proof');
    });

    it('returns expired-specific recovery hint on expired proof', async () => {
      const client = mockClient({
        redeem: async () => ({
          valid: false,
          reason: 'expired',
          expired: true,
        }),
      });
      const tool = makeSampleTool(client);
      const result = await tool.callback(validProofArgs, {} as never);
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.reason).toBe('expired');
      expect(parsed.expired).toBe(true);
      expect(parsed.recovery_hint).toContain('expired');
    });

    it('returns already_redeemed-specific recovery hint on replay', async () => {
      const client = mockClient({
        redeem: async () => ({
          valid: false,
          reason: 'already_redeemed',
        }),
      });
      const tool = makeSampleTool(client);
      const result = await tool.callback(validProofArgs, {} as never);
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.reason).toBe('already_redeemed');
      expect(parsed.recovery_hint).toContain('already consumed');
    });

    it('returns sanitized isError if client.redeem throws (stage=redeem)', async () => {
      const client = mockClient({
        redeem: async () => {
          throw new Error('HTTP 500: btxd internal: txid 0xdeadbeef state UTXO spent');
        },
      });
      const tool = makeSampleTool(client);
      const result = await tool.callback(validProofArgs, {} as never);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.btx_internal_error).toBe(true);
      expect(parsed.stage).toBe('redeem');
      // Audit HIGH-1: blockchain state details must not leak
      expect(parsed.message).not.toContain('UTXO');
      expect(parsed.message).not.toContain('0xdeadbeef');
    });

    it('fires onAdmit hook on successful admission', async () => {
      const client = mockClient();
      const onAdmit = vi.fn();
      const tool = btxToolWrapper({
        name: 't',
        inputSchema: { q: z.string() },
        handler: async () => ({ content: [] }),
        gate: { client, purpose: 'p', resource: 'r', subject: 's', onAdmit, issueParams: {} },
      });
      await tool.callback(
        {
          q: 'hello',
          btx_proof: { challenge: STUB_CHALLENGE, nonce64_hex: 'aa', digest_hex: 'bb' },
        },
        {} as never,
      );
      expect(onAdmit).toHaveBeenCalledOnce();
      const [admitArgs, admitResult] = onAdmit.mock.calls[0]!;
      expect(admitArgs).toEqual({ q: 'hello' });
      expect((admitResult as { valid: boolean }).valid).toBe(true);
    });

    it.each([
      ['invalid_proof', 'digest computation'],
      ['challenge_mismatch', 'echoed back does not match'],
      ['unknown_challenge', 'btxd does not recognize'],
      ['missing_proof', 'nonce64_hex and btx_proof.digest_hex must both be present'],
      ['mismatch_field', 'echoed back does not match'],
    ])('returns reason-specific recovery_hint for %s', async (reason, hintContains) => {
      const client = mockClient({
        redeem: async () => ({ valid: false, reason }),
      });
      const tool = makeSampleTool(client);
      const result = await tool.callback(validProofArgs, {} as never);
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.reason).toBe(reason);
      expect(parsed.recovery_hint).toContain(hintContains);
    });

    it('passes additional user args to the handler unmodified', async () => {
      const client = mockClient();
      const handler = vi.fn(async (args: { foo: string; bar: number }) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(args) }],
      }));
      const tool = btxToolWrapper({
        name: 'test',
        inputSchema: { foo: z.string(), bar: z.number() },
        handler,
        gate: { client, purpose: 'p', resource: 'r', subject: 's', issueParams: {} },
      });
      await tool.callback(
        {
          foo: 'hello',
          bar: 42,
          btx_proof: {
            challenge: STUB_CHALLENGE,
            nonce64_hex: 'aa',
            digest_hex: 'bb',
          },
        },
        {} as never,
      );
      expect(handler.mock.calls[0]![0]).toEqual({ foo: 'hello', bar: 42 });
    });
  });

  describe('inputSchema augmentation', () => {
    it('augments inputSchema with optional btx_proof', () => {
      const client = mockClient();
      const tool = makeSampleTool(client);
      expect(tool.inputSchema.query).toBeDefined();
      expect(tool.inputSchema.btx_proof).toBeDefined();
      // Verify btx_proof is optional by parsing without it
      const schema = z.object(tool.inputSchema);
      const parsed = schema.safeParse({ query: 'hello' });
      expect(parsed.success).toBe(true);
    });

    it('btx_proof requires the three expected fields when present', () => {
      const client = mockClient();
      const tool = makeSampleTool(client);
      const schema = z.object(tool.inputSchema);
      const validProof = schema.safeParse({
        query: 'hello',
        btx_proof: {
          challenge: { anything: 'goes' },
          nonce64_hex: 'aa',
          digest_hex: 'bb',
        },
      });
      expect(validProof.success).toBe(true);

      const missingNonce = schema.safeParse({
        query: 'hello',
        btx_proof: {
          challenge: {},
          digest_hex: 'bb',
        },
      });
      expect(missingNonce.success).toBe(false);
    });
  });
});
