/**
 * Example tool — `expensive_search`. A search stub that demonstrates the
 * basic BTX admission pattern at moderate difficulty.
 *
 * Not exported by default. Consumers must explicitly import + register:
 *   import { expensiveSearchTool } from '@btx-tools/mcp-gateway/example-tools';
 */

import { z } from 'zod';

import type { BtxChallengeClient } from '@btx-tools/challenges-sdk';

import { btxToolWrapper } from '../wrapper.js';
import type { WrappedBtxTool } from '../types.js';

/**
 * Build a wrapped `expensive_search` tool bound to the given client.
 *
 * @param client - the BtxChallengeClient instance to use for issue + redeem
 * @param targetSolveTimeS - calibrates difficulty; default 1.0s for the
 *   "moderate cost" tier. Drop to 0.001 for floor-difficulty demos.
 */
export function expensiveSearchTool(
  client: BtxChallengeClient,
  targetSolveTimeS = 1.0,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): WrappedBtxTool<any> {
  return btxToolWrapper({
    name: 'expensive_search',
    title: 'Expensive Search (BTX-gated)',
    description:
      'Search a large index. Stub. Gated to deter automated agent abuse — each call requires a BTX service-challenge proof.',
    annotations: {
      title: 'Expensive Search',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      query: z.string().describe('Search query string'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results to return'),
    },
    handler: async ({ query, limit }) => {
      const n = limit ?? 10;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                query,
                limit: n,
                results: Array.from({ length: n }, (_, i) => ({
                  rank: i + 1,
                  title: `Result ${i + 1} for "${query}" (stub)`,
                  snippet: '...',
                })),
                _note: 'Stub tool — real implementation would hit a real search index.',
              },
              null,
              2,
            ),
          },
        ],
      };
    },
    gate: {
      client,
      purpose: 'agent_tool_call',
      resource: ({ query }) =>
        `tool:expensive_search|q_len:${(query as string).length}`,
      subject: 'anonymous_agent',
      issueParams: {
        target_solve_time_s: targetSolveTimeS,
        expires_in_s: 300,
      },
    },
  });
}
