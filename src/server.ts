/**
 * `createBtxMcpServer` — factory that wires BTX-wrapped tools into an MCP
 * `McpServer` instance.
 *
 * Caller decides which transport to attach (stdio / HTTP+SSE / custom). The
 * returned server is ready to `.connect(transport)`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { CreateBtxMcpServerOpts } from './types.js';

/**
 * Construct an MCP server with BTX admission-gated tools.
 *
 * @example
 * ```ts
 * import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
 * import { createBtxMcpServer, btxToolWrapper } from '@btx-tools/mcp-gateway';
 *
 * const server = createBtxMcpServer({
 *   name: 'my-gated-tools',
 *   version: '0.1.0',
 *   tools: [
 *     btxToolWrapper({ ... }),
 *     btxToolWrapper({ ... }),
 *   ],
 * });
 *
 * await server.connect(new StdioServerTransport());
 * ```
 */
export function createBtxMcpServer(opts: CreateBtxMcpServerOpts): McpServer {
  const server = new McpServer(
    {
      name: opts.name,
      version: opts.version,
    },
    opts.instructions ? { instructions: opts.instructions } : undefined,
  );

  for (const tool of opts.tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      // The MCP SDK passes parsed-and-validated args + extra context; our
      // wrapper signature matches.
      tool.callback as Parameters<typeof server.registerTool>[2],
    );
  }

  return server;
}
