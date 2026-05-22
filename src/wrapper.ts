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

/**
 * Marker for an internal/transport error (issue or redeem RPC threw).
 * Distinct from BTX_ADMISSION_FAILED_MARKER (which is a structured rejection
 * from btxd, e.g. invalid proof). Internal errors are sanitized — only the
 * stage is exposed, not the underlying error message, to avoid leaking
 * server-internal details (btxd URL, RPC method names, response snippets).
 */
export const BTX_INTERNAL_ERROR_MARKER = 'btx_internal_error';

function resolve<Args>(value: StringOrFn<Args>, args: Args): string {
  return typeof value === 'function' ? value(args) : value;
}

/**
 * Per-reason recovery hint. Audit MED-3: covers all VerifyReason values from
 * @btx-tools/challenges-sdk's types.ts, with semantically-specific guidance
 * rather than a single generic fallback.
 */
function recoveryHintFor(reason: string): string {
  switch (reason) {
    case 'already_redeemed':
      return 'This proof was already consumed. Call this tool with no btx_proof to get a fresh challenge.';
    case 'expired':
      return 'The challenge has expired. Call this tool with no btx_proof to get a fresh one.';
    case 'invalid_proof':
      return 'The proof bytes do not match the challenge (digest computation failed or nonce wrong). Re-solve and retry — do not reuse the previous nonce.';
    case 'challenge_mismatch':
    case 'mismatch_field':
      return 'The challenge envelope echoed back does not match what was issued for this (purpose, resource, subject) binding. Make sure btx_proof.challenge is the exact envelope returned by the previous 402 — do not mutate it.';
    case 'unknown_challenge':
      return 'btxd does not recognize this challenge (it was never issued by this node, or the issued-challenge store was cleared). Call this tool with no btx_proof to get a fresh challenge from the same gateway.';
    case 'missing_proof':
      return 'btx_proof.nonce64_hex and btx_proof.digest_hex must both be present and non-empty. Verify your retry payload.';
    default:
      return 'The proof was rejected by btxd. Call this tool with no btx_proof to get a fresh challenge.';
  }
}

function challengeEnvelope(challenge: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          btx_admission_challenge_required: true,
          marker: BTX_CHALLENGE_MARKER,
          challenge,
          retry_hint:
            'Solve this BTX challenge with @btx-tools/challenges-sdk (Solver.solve), then call this tool again with btx_proof populated (challenge, nonce64_hex, digest_hex).',
          do_not_auto_retry:
            'This is NOT a transient error. Auto-retrying without solving the proof-of-work will loop indefinitely. See https://github.com/btx-tools/btx-mcp-gateway#how-it-works',
        }),
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
        text: JSON.stringify({
          btx_admission_failed: true,
          marker: BTX_ADMISSION_FAILED_MARKER,
          reason,
          expired,
          recovery_hint: recoveryHintFor(reason),
        }),
      },
    ],
    isError: true,
  };
}

/**
 * Sanitized internal-error response. Audit HIGH-1: the underlying error's
 * message is NOT included in the agent-visible body because it may carry
 * btxd hostname / RPC method names / response snippets that we don't want
 * to leak to untrusted clients. The error is delivered to the optional
 * `gate.onError` hook instead — adopters wire that to their logging/APM.
 */
function internalErrorResponse(stage: 'issue' | 'redeem'): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          btx_internal_error: true,
          marker: BTX_INTERNAL_ERROR_MARKER,
          stage,
          message:
            'Admission gateway encountered an internal error talking to btxd. Retry after a short backoff; if it persists, contact the gateway operator. The full error has been logged server-side.',
        }),
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
 *     onError: (err) => myAPM.captureException(err),
 *     onAdmit: (args, result) => myAPM.recordAdmission(args, result),
 *   },
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
    const typedUserArgs = userArgs as { [K in keyof InputArgs]: z.infer<InputArgs[K]> };

    // 0.2.0: forward MCP transport's AbortSignal to the BTX RPC client so an
    // agent client that cancels a tool call mid-issue or mid-redeem propagates
    // through to fetch-level cancellation. Closes audit MED-8.
    const signal = _extra.signal;

    // First call: no proof → issue and return challenge envelope
    if (!btx_proof) {
      try {
        const purpose = resolve(def.gate.purpose, typedUserArgs);
        const resource = resolve(def.gate.resource, typedUserArgs);
        const subject = resolve(def.gate.subject, typedUserArgs);
        // Audit HIGH-2: explicit (purpose, resource, subject) MUST come AFTER
        // the spread so issueParams can never override the admission binding,
        // even via runtime injection or TypeScript bypass.
        const challenge = await def.gate.client.issue(
          {
            ...def.gate.issueParams,
            purpose,
            resource,
            subject,
          },
          { signal },
        );
        return challengeEnvelope(challenge);
      } catch (err) {
        def.gate.onError?.(err, typedUserArgs);
        return internalErrorResponse('issue');
      }
    }

    // Retry with proof: redeem. Cast `as Challenge` is safe at the trust
    // boundary — btxd's redeem RPC validates the envelope structure itself
    // and returns reason='unknown_challenge' / 'challenge_mismatch' if the
    // wire shape is wrong.
    let result;
    try {
      result = await def.gate.client.redeem(
        btx_proof.challenge as Challenge,
        btx_proof.nonce64_hex,
        btx_proof.digest_hex,
        { signal },
      );
    } catch (err) {
      def.gate.onError?.(err, typedUserArgs);
      return internalErrorResponse('redeem');
    }

    if (!result.valid) {
      return admissionFailedResponse(String(result.reason), result.expired);
    }

    // Admitted — fire onAdmit hook, then invoke user handler with stripped
    // args + admission context.
    def.gate.onAdmit?.(typedUserArgs, result);
    return def.handler(typedUserArgs, {
      ..._extra,
      btx: { result },
    });
  };

  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: augmentedInputSchema,
    outputSchema: def.outputSchema,
    annotations: def.annotations,
    _meta: def._meta,
    callback,
  };
}
