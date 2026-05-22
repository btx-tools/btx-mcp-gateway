/**
 * `btxToolWrapper` — wraps any MCP tool definition with a BTX service-challenge
 * admission gate.
 *
 * Flow on `tools/call`:
 *   1. Inspect arguments for `btx_proof`
 *   2. If absent → call `client.issue(...)` and return a structured
 *      `isError: true` result containing the challenge envelope. The caller
 *      solves it (locally or via RPC) and retries the call with `btx_proof`
 *      populated.
 *   3. If present → call `client.redeem(...)`. On invalid → `isError: true`
 *      with the reason. On valid → invoke the user's handler with admission
 *      context.
 *
 * Mirrors the echo-the-challenge flow of `@btx-tools/middleware-express`
 * (HTTP 402 → solve → retry), adapted to MCP's `tools/call` envelope.
 */

import { z, type ZodRawShape } from 'zod';

import type { BtxChallengeClient, Challenge } from '@btx-tools/challenges-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type {
  BtxGateOptions,
  BtxProofPayload,
  BtxToolDefinition,
  StringOrFn,
  WrappedBtxTool,
} from './types.js';

/** Zod schema for the injected `btx_proof` field. */
const BtxProofSchema = z.object({
  challenge: z.unknown(),
  nonce64_hex: z.string(),
  digest_hex: z.string(),
});

/**
 * Marker string embedded in the challenge envelope's text content so MCP
 * clients (and agent operators reading their logs) can recognize a BTX
 * admission challenge vs an ordinary error. **Do NOT auto-retry** an
 * `isError: true` result that carries this marker — it requires solving a
 * proof-of-work; an unaware client would loop indefinitely.
 */
export const BTX_CHALLENGE_MARKER = 'btx_admission_challenge_required';

/** Marker for an admission failure (proof was present but invalid). */
export const BTX_ADMISSION_FAILED_MARKER = 'btx_admission_failed';

function resolve<Args>(value: StringOrFn<Args>, args: Args): string {
  return typeof value === 'function' ? value(args) : value;
}

function challengeEnvelope(challenge: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            btx_admission_challenge_required: true,
            marker: BTX_CHALLENGE_MARKER,
            challenge,
            retry_hint:
              'Solve this BTX challenge with @btx-tools/challenges-sdk (Solver.solve), then call this tool again with btx_proof populated (challenge, nonce64_hex, digest_hex).',
            do_not_auto_retry:
              'This is NOT a transient error. Auto-retrying without solving the proof-of-work will loop indefinitely. See https://github.com/btx-tools/btx-mcp-gateway#how-it-works',
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

function admissionFailedResponse(reason: string, expired?: boolean): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            btx_admission_failed: true,
            marker: BTX_ADMISSION_FAILED_MARKER,
            reason,
            expired,
            recovery_hint:
              reason === 'already_redeemed'
                ? 'This proof was already consumed. Call this tool with no btx_proof to get a fresh challenge.'
                : reason === 'expired'
                  ? 'The challenge has expired. Call this tool with no btx_proof to get a fresh one.'
                  : 'The proof was rejected. Call this tool with no btx_proof to get a fresh challenge.',
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

/**
 * Wrap an MCP tool definition with BTX admission gating.
 *
 * @example
 * ```ts
 * import { z } from 'zod';
 * import { btxToolWrapper, createBtxMcpServer } from '@btx-tools/mcp-gateway';
 * import { BtxChallengeClient } from '@btx-tools/challenges-sdk';
 *
 * const client = new BtxChallengeClient({
 *   rpcUrl: 'http://127.0.0.1:19334',
 *   rpcAuth: { user: 'rpcuser', pass: 'rpcpass' },
 * });
 *
 * const search = btxToolWrapper({
 *   name: 'expensive_search',
 *   description: 'Search a large index. Gated to deter agent abuse.',
 *   inputSchema: { query: z.string() },
 *   handler: async ({ query }) => ({
 *     content: [{ type: 'text', text: `Result for: ${query}` }],
 *   }),
 *   gate: {
 *     client,
 *     purpose: 'agent_tool_call',
 *     resource: ({ query }) => `tool:expensive_search|q_len:${query.length}`,
 *     subject: 'anonymous_agent',
 *     issueParams: { target_solve_time_s: 1.0, expires_in_s: 300 },
 *   },
 * });
 *
 * const server = createBtxMcpServer({
 *   name: 'my-gated-tools',
 *   version: '0.1.0',
 *   tools: [search],
 * });
 * ```
 */
export function btxToolWrapper<InputArgs extends ZodRawShape>(
  def: BtxToolDefinition<InputArgs>,
): WrappedBtxTool<InputArgs> {
  // Augment the user's inputSchema with an optional `btx_proof` field. We use
  // `optional` (not `nullable`) so callers can omit the field entirely on the
  // first call without sending an explicit `null`.
  const augmentedInputSchema = {
    ...def.inputSchema,
    btx_proof: BtxProofSchema.optional(),
  } as InputArgs & { btx_proof: z.ZodOptional<typeof BtxProofSchema> };

  const callback: WrappedBtxTool<InputArgs>['callback'] = async (rawArgs, _extra) => {
    // The MCP SDK validates rawArgs against augmentedInputSchema before calling
    // us, so we can safely cast.
    const args = rawArgs as Record<string, unknown> & {
      btx_proof?: BtxProofPayload;
    };
    const { btx_proof, ...userArgs } = args;

    // First call: no proof → issue and return challenge envelope
    if (!btx_proof) {
      try {
        const purpose = resolve(def.gate.purpose, userArgs as never);
        const resource = resolve(def.gate.resource, userArgs as never);
        const subject = resolve(def.gate.subject, userArgs as never);
        const challenge = await def.gate.client.issue({
          purpose,
          resource,
          subject,
          ...def.gate.issueParams,
        });
        return challengeEnvelope(challenge);
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                btx_internal_error: true,
                message: err instanceof Error ? err.message : String(err),
                stage: 'issue',
              }),
            },
          ],
          isError: true,
        };
      }
    }

    // Retry with proof: redeem
    let result;
    try {
      result = await def.gate.client.redeem(
        btx_proof.challenge as Challenge,
        btx_proof.nonce64_hex,
        btx_proof.digest_hex,
      );
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              btx_internal_error: true,
              message: err instanceof Error ? err.message : String(err),
              stage: 'redeem',
            }),
          },
        ],
        isError: true,
      };
    }

    if (!result.valid) {
      return admissionFailedResponse(String(result.reason), result.expired);
    }

    // Admitted — invoke user handler with stripped args + admission context
    return def.handler(
      userArgs as { [K in keyof InputArgs]: z.infer<InputArgs[K]> },
      {
        ..._extra,
        btx: { result },
      },
    );
  };

  return {
    name: def.name,
    description: def.description,
    inputSchema: augmentedInputSchema,
    callback,
  };
}
