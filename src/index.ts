/**
 * @btx-tools/mcp-gateway
 *
 * MCP server framework that gates every tool invocation behind a BTX
 * service-challenge proof. Companion to `@btx-tools/challenges-sdk`.
 *
 * Why: agentic AI systems need admission control that doesn't depend on
 * identity. BTX service-challenges price each tool call in compute,
 * naturally rate-limiting runaway agents while staying invisible to
 * legitimate use.
 *
 * Pattern: each gated tool's `inputSchema` is augmented with an optional
 * `btx_proof` field. Calling the tool without it returns `isError: true`
 * with the challenge envelope; the agent solves it (locally via
 * `@btx-tools/challenges-sdk`'s `Solver.solve`, or by delegating to a
 * dedicated non-mining btxd) and retries the call with `btx_proof` populated.
 *
 * @see https://github.com/btx-tools/btx-mcp-gateway
 * @see https://github.com/btx-tools/btx-challenges-sdk/blob/main/USE-CASES.md
 */

export { createBtxMcpServer } from './server.js';
export {
  btxToolWrapper,
  BTX_CHALLENGE_MARKER,
  BTX_ADMISSION_FAILED_MARKER,
} from './wrapper.js';
export type {
  BtxProofPayload,
  BtxGateOptions,
  BtxAdmissionContext,
  BtxToolExtra,
  BtxToolDefinition,
  CreateBtxMcpServerOpts,
  WrappedBtxTool,
  StringOrFn,
} from './types.js';
