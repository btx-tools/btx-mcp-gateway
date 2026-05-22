/**
 * Reference stdio MCP server with two BTX-gated example tools.
 *
 * Run: `pnpm example:server`
 *
 * Then connect with any MCP client (Claude Desktop, mcp-cli, or our
 * companion `client-demo.ts`). The first `tools/call` returns an `isError`
 * result containing a BTX challenge envelope; solve it with
 * `@btx-tools/challenges-sdk`'s `Solver.solve`, then call again with the
 * `btx_proof` argument populated.
 *
 * Environment:
 *   BTX_RPC_URL   — e.g. http://127.0.0.1:19334
 *   BTX_RPC_AUTH  — "user:pass"
 *
 * Note: at production difficulty (target_solve_time_s ≥ 1.0), pure-JS browser
 * solving takes hours. For agent demos, this example uses floor difficulty
 * (0.001s). See https://github.com/btx-tools/btx-challenges-sdk/blob/main/USE-CASES.md
 */

import { BtxChallengeClient } from '@btx-tools/challenges-sdk';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createBtxMcpServer } from '../src/index.js';
import {
  expensiveSearchTool,
  secureCalendarWriteTool,
} from '../src/example-tools/index.js';

async function main(): Promise<void> {
  const rpcUrl = process.env.BTX_RPC_URL;
  const rpcAuth = process.env.BTX_RPC_AUTH;
  if (!rpcUrl || !rpcAuth) {
    console.error('error: set BTX_RPC_URL and BTX_RPC_AUTH (e.g. user:pass)');
    process.exit(1);
  }
  // Audit MED-6: split only on the FIRST colon so passwords containing ':'
  // round-trip correctly. The previous `split(':')` truncated multi-colon
  // passwords silently.
  const sepIdx = rpcAuth.indexOf(':');
  if (sepIdx <= 0 || sepIdx === rpcAuth.length - 1) {
    console.error('error: BTX_RPC_AUTH must be of the form "user:pass" (both parts non-empty)');
    process.exit(1);
  }
  const user = rpcAuth.slice(0, sepIdx);
  const pass = rpcAuth.slice(sepIdx + 1);

  const client = new BtxChallengeClient({
    rpcUrl,
    rpcAuth: { user, pass },
    timeoutMs: 60_000,
  });

  // Floor difficulty so demo solves complete within a session. Bump these to
  // 1.0s+ for production.
  const FLOOR_TARGET = 0.001;

  const server = createBtxMcpServer({
    name: 'btx-mcp-gateway-example',
    version: '0.1.0',
    instructions:
      'BTX-gated MCP server. Each tool call must include a btx_proof argument. ' +
      'Call any tool without btx_proof to receive a challenge envelope; solve it ' +
      'with @btx-tools/challenges-sdk and retry. See ' +
      'https://github.com/btx-tools/btx-mcp-gateway for details.',
    tools: [
      expensiveSearchTool(client, FLOOR_TARGET),
      secureCalendarWriteTool(client, FLOOR_TARGET),
    ],
  });

  // Stdio is the canonical transport for agent host clients (Claude Desktop,
  // Cline, mcp-cli). HTTP+SSE is a 0.2.0 follow-up.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr only — stdout is the MCP transport. Stderr goes to the
  // host's log pane / journal.
  console.error('btx-mcp-gateway-example listening on stdio');
}

main().catch((err) => {
  console.error('server failed:', err);
  process.exit(1);
});
