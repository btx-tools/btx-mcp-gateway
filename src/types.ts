/**
 * Public types for @btx-tools/mcp-gateway.
 */

import type { z, ZodRawShape } from 'zod';

import type {
  BtxChallengeClient,
  IssueParams,
  VerifyResult,
} from '@btx-tools/challenges-sdk';

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  ServerNotification,
  ServerRequest,
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Wire shape of the proof that a BTX-gated tool expects in its `btx_proof`
 * argument. Mirrors the (challenge, nonce64_hex, digest_hex) tuple the SDK's
 * `client.redeem()` consumes.
 */
export interface BtxProofPayload {
  challenge: unknown;
  nonce64_hex: string;
  digest_hex: string;
}

/**
 * Resolved-or-deriver — either a static string or a function of the tool's
 * input arguments. Matches the SDK middleware ergonomics.
 */
export type StringOrFn<Args> = string | ((args: Args) => string);

/**
 * Per-tool gate configuration.
 */
export interface BtxGateOptions<Args> {
  client: BtxChallengeClient;
  purpose: StringOrFn<Args>;
  resource: StringOrFn<Args>;
  subject: StringOrFn<Args>;
  /**
   * Forwarded to `client.issue()` — e.g. `target_solve_time_s`,
   * `expires_in_s`. `purpose`, `resource`, `subject` are deliberately
   * excluded from this type (they must come from the top-level options) AND
   * the wrapper spreads issueParams BEFORE the explicit binding fields so
   * runtime injection can't override the admission binding either. Audit
   * HIGH-2 defense-in-depth.
   */
  issueParams?: Partial<Omit<IssueParams, 'purpose' | 'resource' | 'subject'>>;
  /**
   * Enforce that the redeemed proof's challenge `binding.{purpose,resource,
   * subject}` matches what THIS tool call resolves to (audit H-1). Default
   * **`true`**. Without it, a valid proof issued for one tool/binding could be
   * replayed to admit a *different*, more-expensive tool on the same btxd
   * (btxd's redeem can't see which tool is calling). Resolvers must be
   * deterministic for a given args input. Set `false` only for intentional
   * cross-tool proof reuse.
   */
  enforceBinding?: boolean;
  /**
   * Optional hook fired exactly once when `client.issue()` or
   * `client.redeem()` throws, before the wrapper returns the sanitized
   * internal-error response. Use this to log/observe the underlying error
   * (which is NOT exposed to the agent caller for security reasons —
   * audit HIGH-1). Mirrors the `onError` hook in `middleware-express` 0.2.0.
   */
  onError?: (err: unknown, args: Args) => void;
  /**
   * Optional hook fired exactly once on successful admission, BEFORE the
   * user handler runs. Use this for observability — log admission events,
   * record metrics, track per-(purpose, resource, subject) admission rates.
   * Mirrors the `onAdmit` hook in `middleware-express`.
   */
  onAdmit?: (args: Args, result: VerifyResult) => void;
}

/**
 * Context object injected into the user's tool handler on successful admission.
 * Carries the `client.redeem()` result so the handler can introspect the
 * proof's reason / redeem state.
 */
export interface BtxAdmissionContext {
  /** The result of the redeem call that admitted this tool invocation. */
  result: VerifyResult;
}

/**
 * Extra context passed to the user's tool handler. Extends the MCP SDK's
 * `RequestHandlerExtra` with a `btx` namespace carrying admission info.
 */
export type BtxToolExtra = RequestHandlerExtra<
  ServerRequest,
  ServerNotification
> & {
  btx: BtxAdmissionContext;
};

/**
 * Definition for a BTX-gated MCP tool. Shape mirrors `McpServer.registerTool`
 * minus the `btx_proof` field, which we inject automatically.
 *
 * Handler receives the parsed args (minus `btx_proof`) and `BtxToolExtra`
 * (the standard MCP extra + a `btx` admission context).
 */
export interface BtxToolDefinition<InputArgs extends ZodRawShape> {
  name: string;
  /** Human-readable display title. Forwarded to MCP `registerTool({ title })`. */
  title?: string;
  description?: string;
  /**
   * Zod raw shape for the tool's input arguments. We inject an optional
   * `btx_proof` field automatically — DO NOT define one yourself.
   */
  inputSchema: InputArgs;
  /**
   * Optional output schema. Forwarded to MCP `registerTool({ outputSchema })`
   * so clients can introspect + validate the tool's return shape.
   * Audit MED-4.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outputSchema?: ZodRawShape | any;
  /**
   * Optional MCP tool annotations (`readOnlyHint`, `destructiveHint`,
   * `idempotentHint`, `openWorldHint`, `title`). Forwarded to MCP
   * `registerTool({ annotations })`. Strongly recommended for mutation
   * tools so clients can require user confirmation. Audit MED-5.
   */
  annotations?: ToolAnnotations;
  /**
   * Optional `_meta` extension field forwarded to MCP `registerTool({ _meta })`.
   * Use for custom metadata (cost tier, billing tag, audit hint, etc.).
   * Audit LOW (Angle E #4).
   */
  _meta?: Record<string, unknown>;
  /**
   * Tool handler — runs only on successful admission. Receives parsed args
   * (typed from `inputSchema`) and a `BtxToolExtra` with admission context.
   */
  handler: (
    args: { [K in keyof InputArgs]: z.infer<InputArgs[K]> },
    extra: BtxToolExtra,
  ) => CallToolResult | Promise<CallToolResult>;
  /** Per-tool gate configuration. */
  gate: BtxGateOptions<{ [K in keyof InputArgs]: z.infer<InputArgs[K]> }>;
}

/**
 * Options for {@link createBtxMcpServer}.
 */
export interface CreateBtxMcpServerOpts {
  /** Server name advertised to clients. */
  name: string;
  /** Server version advertised to clients. */
  version: string;
  /** Tools to register. Each must be wrapped via {@link btxToolWrapper}. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: WrappedBtxTool<any>[];
  /** Optional human-readable usage instructions exposed via MCP. */
  instructions?: string;
}

/**
 * Result of {@link btxToolWrapper} — a tool ready to be handed to
 * {@link createBtxMcpServer}. Don't construct these by hand; use the wrapper.
 */
export interface WrappedBtxTool<InputArgs extends ZodRawShape> {
  name: string;
  title?: string;
  description: string | undefined;
  /** The user's inputSchema merged with our injected `btx_proof` field. */
  inputSchema: InputArgs & {
    btx_proof: z.ZodOptional<
      z.ZodObject<{
        challenge: z.ZodUnknown;
        nonce64_hex: z.ZodString;
        digest_hex: z.ZodString;
      }>
    >;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outputSchema?: ZodRawShape | any;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  /** The internal callback handed to `server.registerTool`. Don't call directly. */
  callback: (
    args: unknown,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ) => Promise<CallToolResult>;
}
