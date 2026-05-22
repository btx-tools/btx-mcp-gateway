# Changelog

All notable changes to `@btx-tools/mcp-gateway` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) + [SemVer](https://semver.org/).

## [0.1.0] - 2026-05-23

First production release. Goes from `0.0.1` scaffold (which exported two constants) to a real MCP server framework.

### Added

- **`createBtxMcpServer({ name, version, tools, instructions? })`** — factory that wires BTX-wrapped tools into an `@modelcontextprotocol/sdk` `McpServer` instance. Caller attaches the transport (stdio is canonical for agent host clients).
- **`btxToolWrapper({ name, description, inputSchema, handler, gate })`** — higher-order function that wraps any tool definition with BTX admission gating. Automatically injects an optional `btx_proof` argument into the tool's `inputSchema`. Returns a `WrappedBtxTool` ready for `createBtxMcpServer`.
- **`BTX_CHALLENGE_MARKER` + `BTX_ADMISSION_FAILED_MARKER`** — string constants embedded in the `isError: true` response body so MCP clients can distinguish a BTX admission challenge from ordinary tool errors.
- **`/example-tools` subpath export** — two illustrative gated tools:
  - `expensiveSearchTool(client, targetSolveTimeS?)` — moderate-cost search stub
  - `secureCalendarWriteTool(client, targetSolveTimeS?)` — higher-cost mutation stub
- **`examples/stdio-server.ts`** — runnable reference server.
- **`examples/client-demo.ts`** — companion client that drives the full admission flow end-to-end (tools/list → tools/call without proof → solve via `@btx-tools/challenges-sdk` Solver → tools/call with proof → result).
- **Tests** — 15 total: 11 unit tests of the wrapper (mocked client) + 4 integration tests using `InMemoryTransport` to wire client and server in-process.
- **TypeScript types** exported for `BtxProofPayload`, `BtxGateOptions`, `BtxAdmissionContext`, `BtxToolExtra`, `BtxToolDefinition`, `CreateBtxMcpServerOpts`, `WrappedBtxTool`, `StringOrFn`.
- **README** with full API surface + the honest performance framing carried from the SDK's `USE-CASES.md` (browser/casual-agent admission is NOT viable at production difficulty; agents need access to a dedicated non-mining btxd for sub-second solves).

### Changed (vs. 0.0.1 scaffold)

- Package name renamed from `@btx/mcp-gateway` to `@btx-tools/mcp-gateway` to match the SDK monorepo scope.
- Repo URL updated from `btx-tools/btx-mcp-gateway` to `btx-tools/btx-mcp-gateway`.
- `@btx-tools/challenges-sdk` is now a `peerDependency` (was `devDependency` only in the scaffold).
- `@modelcontextprotocol/sdk` added as `peerDependency` (was missing in the scaffold).
- Dropped the two `SDK_VERSION` / `STATUS` constants — replaced by the real API surface.

### Out of scope (deferred)

- **HTTP+SSE transport** — stdio covers the dominant agent host clients (Claude Desktop, Cline, mcp-cli). HTTP+SSE is a 0.2.0 follow-up.
- **Auto-resolve client wrapper** — an MCP client that auto-handles the challenge dance so the agent doesn't need BTX awareness. Worth doing eventually but adds complexity; 0.1.0 ships the explicit pattern.
- **Multi-tool batching** — `redeemBatch` already exists in `@btx-tools/challenges-sdk`; layering it on MCP requires session state. Queued for later.
- **Per-agent rate limits beyond compute** — would require agent identity. Out of scope; the whole point is identity-free admission.
