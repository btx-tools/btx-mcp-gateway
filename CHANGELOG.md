# Changelog

All notable changes to `@btx-tools/mcp-gateway` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) + [SemVer](https://semver.org/).

## [0.3.0] - 2026-05-24 — audit remediation — pending publish

Security hardening from the 2026-05-24 org-wide deep audit
(`internal notes`). The gate was
already fail-closed; these tighten the admission decision + close a proof-reuse
gap. No Critical/High were open.

### Security / behavior

- **H-1 — enforce challenge binding (default-on).** Before redeem, the gateway
  now checks the proof's challenge `binding.{purpose,resource,subject}` against
  what THIS tool call resolves to, and denies `challenge_binding_mismatch` on a
  mismatch (checked pre-redeem so a wrong-tool proof isn't consumed). Closes
  cross-tool proof reuse — a proof for a cheap tool could previously admit an
  expensive one on the same btxd. **Behavior change:** binding resolvers must be
  deterministic per args; opt out with `enforceBinding: false`.
- **M-3 — strict admit.** Admit only on `result.valid === true` (and not
  `redeemed === false`); a null/odd redeem result denies.
- **M-4 — the error sanitizer can no longer be flanked.** The post-redeem
  decision + `onAdmit` hook run inside a sanitizing try/catch, so a null result
  or a throwing hook returns the generic internal-error response instead of
  leaking `error.message` to the agent via the MCP SDK. (The user handler still
  runs outside — its errors are tool-domain.)
- **V-3 — `reason` is bucketed to a closed set** before being echoed to the
  agent, so no free-form btxd string can reach the caller.

## [0.2.0] - 2026-05-23

Minor release — AbortSignal plumbing end-to-end. Closes the last remaining audit finding from `internal notes` (MED-8).

### Added

- **MCP `extra.signal` is now forwarded to `client.issue()` and `client.redeem()`** as `RpcCallOpts.signal`. When the MCP transport fires an abort (agent client cancellation, host process shutdown, etc.), the in-flight BTX RPC is cancelled at the fetch layer instead of running to its timeout.

  Behavior:
  - Pre-aborted signal at call entry → `client.issue`/`redeem` throws `BtxNetworkError` immediately, no request sent, wrapper returns the sanitized internal-error response with `gate.onError` fired
  - Abort mid-request → fetch aborted, `BtxNetworkError` thrown, same response path
  - Abort during retry backoff (if the SDK client is configured with retries) → backoff interrupted, retry loop exits

  This pairs with `@btx-tools/challenges-sdk@0.2.0`, which added the `RpcCallOpts.signal` API surface.

### Changed

- **Peer dependency on `@btx-tools/challenges-sdk` bumped to `^0.2.0`** (was `^0.1.1`). Required because the AbortSignal forwarding uses the new `RpcCallOpts` parameter that only exists in `0.2.0+`. Adopters who upgrade `@btx-tools/mcp-gateway` must also upgrade the SDK to `0.2.0` or later — this is why the version bump is MINOR (0.1.x → 0.2.x) rather than PATCH.
- **`devDependencies['@btx-tools/challenges-sdk']` bumped to `^0.2.0`** for local dev consistency.

### Test delta

23 → 25 tests (+2 new: `forwards MCP extra.signal to client.issue() as RpcCallOpts` + `forwards MCP extra.signal to client.redeem() as RpcCallOpts`). Existing `calls client.issue with the resolved purpose/resource/subject` test updated to expect the trailing `{ signal: undefined }` opts arg.

### Audit status

All findings from the 2026-05-23 deep audit now CLOSED. The previously-deferred MED-8 (AbortSignal plumbing) ships in this release alongside the SDK 0.2.0 update.

## [0.1.1] - 2026-05-23

Patch release bundling the `zod` peerDep fix plus all 15 findings from the same-day deep audit (`internal notes`). **Recommended upgrade for all `0.1.0` consumers** — fixes one security-adjacent error-leakage path, one defense-in-depth binding-override path, several Express-middleware-parity feature gaps, and a handful of papercuts.

### Security / correctness

- **HIGH-1 (audit) — error messages are no longer leaked to agents.** When `client.issue()` or `client.redeem()` throws, the wrapper used to embed `err.message` directly in the agent-visible `isError` text. That could surface btxd hostnames, RPC method names, and HTTP response bodies. We now return a generic sanitized message + a new `BTX_INTERNAL_ERROR_MARKER`; the raw error is delivered to the new `gate.onError` hook instead. Test: `tests/unit/wrapper.test.ts` "returns sanitized isError" / "fires onError hook with the raw error".
- **HIGH-2 (audit) — `issueParams` can no longer override the admission binding.** Spread order was `{ purpose, resource, subject, ...issueParams }`, allowing a runtime injection of `issueParams.purpose` to swap the binding. Now spread is `{ ...issueParams, purpose, resource, subject }` so explicit fields always win. TS type `Partial<Omit<IssueParams, 'purpose'|'resource'|'subject'>>` was already correct at compile time; this is defense-in-depth. Test: "issueParams cannot override the (purpose, resource, subject) binding".

### Added — feature gaps closed (Express middleware parity)

- **`gate.onError?: (err, args) => void`** hook fired before the sanitized internal-error response is returned. Mirrors `middleware-express@0.2.0`'s onError. Audit MED-3.
- **`gate.onAdmit?: (args, result) => void`** hook fired on successful admission, before the user handler runs. Mirrors `middleware-express`'s onAdmit. Audit MED-3 (Angle B #8).
- **`BtxToolDefinition.title?: string`** forwarded to `McpServer.registerTool({ title })`. Audit MED-4 (Angle E #1).
- **`BtxToolDefinition.outputSchema?`** forwarded to `McpServer.registerTool({ outputSchema })` — adopters can now declare tool output validation. Audit MED-4 (Angle E #2).
- **`BtxToolDefinition.annotations?: ToolAnnotations`** forwarded — `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` now propagate so MCP clients can warn before destructive tools. Bundled example tools updated: `expensive_search` is `readOnly`, `secure_calendar_write` is `destructive`. Audit MED-5 (Angle E #3).
- **`BtxToolDefinition._meta?: Record<string, unknown>`** forwarded for custom metadata (cost tier, billing tag, audit hint). Audit LOW (Angle E #4).
- **`BTX_INTERNAL_ERROR_MARKER`** exported alongside the existing two markers, so clients can distinguish a sanitized internal error from an admission failure.

### Behavior

- **`recovery_hint` coverage expanded** to cover all known `VerifyReason` values: `invalid_proof`, `challenge_mismatch`, `unknown_challenge`, `missing_proof`, `mismatch_field` now get reason-specific guidance instead of the previous generic hint. Audit MED-3 (Angle A #2 / Angle B #3). Tests: 5 new parameterized cases.

### Fixed

- **`zod` is now a peerDependency** (was a devDependency in `0.1.0`). The `0.1.0` build inadvertently bundled all of zod into the package chunk (~119 KB inlined). With `peerDependencies.zod ^3.23.0`, adopters bring their own version and types unify cleanly. **Chunk size shrunk 122 KB → 3.8 KB** as a result.
- **`tsup.config.ts` adds explicit `external`** for `@btx-tools/challenges-sdk`, `@modelcontextprotocol/sdk`, and `zod`. Belt-and-suspenders so a future config change can't silently re-inline a peer.
- **`examples/stdio-server.ts`**: `BTX_RPC_AUTH` parser now splits on the FIRST colon only, so passwords containing `:` round-trip correctly. Previous `split(':')` silently truncated multi-colon passwords. Audit MED-6 (Angle D #4).
- **`examples/client-demo.ts`**: imports `BTX_CHALLENGE_MARKER` from package root (`../src/index.js`) instead of the internal `../src/wrapper.js`. Adopters who copy this example as their template now see the canonical public import path. Audit LOW (Angle C #6).
- **`examples/client-demo.ts`**: null-checks `parsed.challenge` before casting in `parseChallengeEnvelope`. A hostile or buggy server returning `{ marker, challenge: null }` now throws a clear envelope-shape error at the parse boundary instead of crashing deep inside `Solver.solve`. Audit LOW (Angle A #3).
- **`examples/client-demo.ts`**: `StdioClientTransport` now spawns the workspace-local `tsx` binary (`node_modules/.bin/tsx`) instead of relying on `tsx` being on PATH. Audit LOW (sweep).
- **JSON in all wrapper response bodies is now compact** (dropped `JSON.stringify(_, null, 2)`). Cuts token cost for LLM-based MCP clients. Audit LOW (Angle D #2).
- **`package.json` `prepublishOnly` now invokes `tsup` directly** instead of `pnpm build`. Works under any toolchain (`npm publish` no longer fails if pnpm isn't on PATH). Audit LOW (sweep).
- **Removed `.npmignore`** — redundant with the `files` allowlist in `package.json` (which has higher precedence). Removed to prevent future maintainer confusion. Audit LOW (Angle D #7).

### Tests

- **23 tests pass** (was 15 in 0.1.0): 19 unit + 4 integration. **+8 new tests** covering: sanitized error leakage prevention (2), onError hook firing (1), onAdmit hook firing (1), defense-in-depth on issueParams override (1), reason-specific recovery_hint coverage (5 parameterized).
- Tightened the `expect(result.isError).toBeFalsy()` assertion in the integration test to `expect(result.isError).toBeUndefined()` so a regression that sets `isError: undefined` doesn't pass silently. Audit LOW (Angle A #4).

### Not fixed (knowingly deferred)

- **AbortSignal plumbing** (audit MED-7, Angle E #6) — `extra.signal` from MCP isn't forwarded to `client.issue()` / `client.redeem()`. Requires adding a `signal` option to `@btx-tools/challenges-sdk`'s `BtxChallengeClient`. Tracked separately; will land alongside the SDK API change.
- **Theoretical RequestHandlerExtra getter-spread issue** (Angle C #5 / Angle E #5) — current MCP SDK uses own properties, no actual bug today. Will revisit if SDK adds prototype-based fields.

### Audit doc

Full findings + verification at `internal notes`.

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
