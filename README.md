# @btx-tools/mcp-gateway

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@btx-tools/mcp-gateway)](https://www.npmjs.com/package/@btx-tools/mcp-gateway)

MCP server framework that gates every tool invocation behind a [BTX](https://btx.dev) service-challenge proof. Companion to [`@btx-tools/challenges-sdk`](https://www.npmjs.com/package/@btx-tools/challenges-sdk).

> **Status**: `0.1.0` — first production release. 15 tests across unit + integration. Built against `@modelcontextprotocol/sdk@^1.29.0`.

## Why

Agentic AI systems need admission control that doesn't depend on identity. API keys assume you know who's calling. Cloudflare Turnstile assumes a browser + human. Agents are code, often anonymous, often shared across users.

BTX service-challenges price each tool call in compute — a chain-anchored proof-of-work that's cheap to verify (~ms) but costs the caller real work to produce. Runaway agents pay per call; legitimate use is invisible.

This package wraps any MCP tool with the gate. One line, drop in.

```ts
import { btxToolWrapper, createBtxMcpServer } from '@btx-tools/mcp-gateway';
import { BtxChallengeClient } from '@btx-tools/challenges-sdk';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const client = new BtxChallengeClient({
  rpcUrl: 'http://127.0.0.1:19334',           // dedicated NON-mining btxd
  rpcAuth: { user: 'rpcuser', pass: 'rpcpass' },
});

const server = createBtxMcpServer({
  name: 'my-gated-tools',
  version: '0.1.0',
  tools: [
    btxToolWrapper({
      name: 'expensive_search',
      description: 'Search a large index. Gated against agent abuse.',
      inputSchema: { query: z.string() },
      handler: async ({ query }) => ({
        content: [{ type: 'text', text: `result for: ${query}` }],
      }),
      gate: {
        client,
        purpose: 'agent_tool_call',
        resource: ({ query }) => `tool:expensive_search|q_len:${query.length}`,
        subject: 'anonymous_agent',
        issueParams: { target_solve_time_s: 1.0, expires_in_s: 300 },
      },
    }),
  ],
});

await server.connect(new StdioServerTransport());
```

## Install

```bash
npm install @btx-tools/mcp-gateway @btx-tools/challenges-sdk @modelcontextprotocol/sdk zod
```

`@btx-tools/challenges-sdk` and `@modelcontextprotocol/sdk` are peer dependencies — bring your own pinned version.

## How it works

When an MCP client calls a wrapped tool, the gate runs first:

```
agent → tools/call expensive_search { query: "foo" }
gateway ← btxd issue
agent ← { isError: true, content: [text with challenge envelope] }

[agent solves challenge via @btx-tools/challenges-sdk Solver.solve]

agent → tools/call expensive_search {
  query: "foo",
  btx_proof: { challenge, nonce64_hex, digest_hex }
}
gateway ← btxd redeem
agent ← { content: [text with actual tool output] }
```

The challenge envelope text contains a `marker: "btx_admission_challenge_required"` field so MCP clients can distinguish it from ordinary errors. **Do not auto-retry** on receiving an `isError: true` result with this marker — solving the proof-of-work is the caller's responsibility, and a naive auto-retry will loop indefinitely.

Replay protection: each (challenge, nonce, digest) tuple is redeemable exactly once. A second call with the same proof returns `marker: "btx_admission_failed"` + `reason: "already_redeemed"`.

## API

### `btxToolWrapper(definition)`

Wrap a tool definition with BTX admission gating.

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | ✅ | Tool name exposed via `tools/list` |
| `description` | `string` | | Tool description exposed via `tools/list` |
| `inputSchema` | `ZodRawShape` | ✅ | Tool's input arguments as a Zod raw shape (e.g. `{ query: z.string() }`). The wrapper automatically injects an optional `btx_proof` field — **don't define one yourself** |
| `handler` | `(args, extra) => CallToolResult` | ✅ | Tool implementation. Receives parsed args (without `btx_proof`) and `extra` (standard MCP extra + `extra.btx.result` admission context) |
| `gate.client` | `BtxChallengeClient` | ✅ | The SDK client constructed at boot |
| `gate.purpose` | `string \| (args) => string` | ✅ | Logical purpose label — `'agent_tool_call'`, your own, etc. |
| `gate.resource` | `string \| (args) => string` | ✅ | Resource identifier — what's being gated. Different for each tool |
| `gate.subject` | `string \| (args) => string` | ✅ | Subject identifier — who's being challenged |
| `gate.issueParams` | `Partial<IssueParams>` | | Forwarded to `client.issue()` — e.g. `target_solve_time_s`, `expires_in_s` |

### `createBtxMcpServer(opts)`

Build an `McpServer` from a list of wrapped tools. Returns an `McpServer` instance ready to `.connect(transport)`.

| Option | Type | Required |
|---|---|---|
| `name` | `string` | ✅ |
| `version` | `string` | ✅ |
| `tools` | `WrappedBtxTool[]` | ✅ |
| `instructions` | `string` | |

## Example tools

The package ships two illustrative tools under `/example-tools` — `expensive_search` (moderate difficulty) and `secure_calendar_write` (higher difficulty for mutations). They're not exported from the package root; import explicitly:

```ts
import { expensiveSearchTool, secureCalendarWriteTool } from '@btx-tools/mcp-gateway/example-tools';

const server = createBtxMcpServer({
  name: 'my-gated-tools',
  version: '0.1.0',
  tools: [
    expensiveSearchTool(client),       // target_solve_time_s: 1.0
    secureCalendarWriteTool(client),   // target_solve_time_s: 4.0
  ],
});
```

See `examples/stdio-server.ts` for a runnable reference + `examples/client-demo.ts` for an end-to-end driver.

## Performance reality

This is the same physics constraint that applies to the rest of the SDK. **Read [USE-CASES.md in the SDK repo](https://github.com/btx-tools/btx-challenges-sdk/blob/main/USE-CASES.md) before deploying.**

The matmul proof-of-work was designed for GPU-fast native mining. Two realistic adopter patterns for MCP:

| Pattern | Solver | Wall-clock at `target_solve_time_s=1.0` |
|---|---|---|
| Agent runs alongside a dedicated non-mining btxd | `Solver.solve({ mode: 'rpc', rpcClient })` | ~1 second |
| Agent in a constrained env (no btxd nearby) | `Solver.solve({ mode: 'pure-js' })` | Hours |

**Realistic deployments:**
- **High-frequency low-value tools** (search, fetch, summarize) — agents that have access to a non-mining btxd via RPC. Sub-second admission.
- **Low-frequency high-value tools** (calendar writes, payments, file mutations) — pure-JS-once-per-session is acceptable when the tool is expensive and rare.

**Don't try to use this for casual every-message agent admission with pure-JS solving** — the user experience will be terrible. The whole point is to make tool calls *cost something*. If your tool call should be free, don't gate it.

## Production notes

### Dedicated non-mining btxd

`solvematmulservicechallenge` and `redeemmatmulserviceproof` share the matmul backend with btxd's block-template mining. Point at a btxd with `gen=0` in `btx.conf`. On a mining-loaded node, RPC calls queue 15+ minutes behind block work.

### Transport choice

`@modelcontextprotocol/sdk` ships several transports. `StdioServerTransport` is what agent host clients (Claude Desktop, Cline, mcp-cli) use today. HTTP+SSE is supported in the SDK but not currently shipped as a `@btx-tools/mcp-gateway` example — coming in 0.2.0.

### Per-tool difficulty

Different tools can carry different `target_solve_time_s` values. Mutations and privileged ops should require more work than reads:

```ts
expensiveSearchTool(client, 1.0)            // moderate cost
secureCalendarWriteTool(client, 4.0)         // higher cost
```

Real adopters should write their own tools, not use the bundled stubs in production.

### Agent client compatibility

Most agent clients today don't natively understand BTX challenges. They'll receive `isError: true` and bubble it up to the agent's reasoning loop, which can then decide to call the tool again with `btx_proof` populated. The `do_not_auto_retry` marker in the response body is a hint to clients that build their own retry logic.

If you're shipping an MCP client of your own, layer a BTX-aware wrapper that auto-handles the dance (Solver.solve → retry).

## Repo links

- npm: https://www.npmjs.com/package/@btx-tools/mcp-gateway
- GitHub: https://github.com/btx-tools/btx-mcp-gateway
- Companion SDK: [`@btx-tools/challenges-sdk`](https://github.com/btx-tools/btx-challenges-sdk)
- MCP spec: [modelcontextprotocol.io](https://modelcontextprotocol.io/specification/)
- BTX dev portal: [btx.dev/develop](https://btx.dev/develop/)

## License

MIT — see [LICENSE](LICENSE).
