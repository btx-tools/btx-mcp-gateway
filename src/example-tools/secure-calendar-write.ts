/**
 * Example tool — `secure_calendar_write`. Demonstrates per-tool difficulty
 * differentiation: higher-stakes tools can require more compute work.
 *
 * The pattern: low-frequency high-value tools (calendar writes, payments,
 * file mutations) use `target_solve_time_s` ≥ 4s. The user (agent operator)
 * accepts that each call is "expensive" — that's the asymmetric-cost defense.
 *
 * Not exported by default. Consumers must explicitly import + register:
 *   import { secureCalendarWriteTool } from '@btx-tools/mcp-gateway/example-tools';
 */

import { z } from 'zod';

import type { BtxChallengeClient } from '@btx-tools/challenges-sdk';

import { btxToolWrapper } from '../wrapper.js';
import type { WrappedBtxTool } from '../types.js';

/**
 * Build a wrapped `secure_calendar_write` tool bound to the given client.
 *
 * @param client - the BtxChallengeClient instance
 * @param targetSolveTimeS - default 4.0s (higher than `expensive_search`'s
 *   1.0s) to reflect the higher-value nature of mutations. Drop to 0.001
 *   for floor-difficulty demos.
 */
export function secureCalendarWriteTool(
  client: BtxChallengeClient,
  targetSolveTimeS = 4.0,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): WrappedBtxTool<any> {
  return btxToolWrapper({
    name: 'secure_calendar_write',
    title: 'Secure Calendar Write (BTX-gated mutation)',
    description:
      'Write a calendar event. Stub. Higher-cost gate than expensive_search — mutations require more BTX compute proof.',
    annotations: {
      title: 'Secure Calendar Write',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      title: z.string().describe('Event title'),
      start_iso: z
        .string()
        .describe('Event start time, ISO 8601 with timezone (e.g. 2026-06-15T14:30:00Z)'),
      duration_minutes: z
        .number()
        .int()
        .min(1)
        .max(1440)
        .describe('Event duration in minutes'),
      attendees: z
        .array(z.string().email())
        .optional()
        .describe('Email addresses of attendees'),
    },
    handler: async ({ title, start_iso, duration_minutes, attendees }) => {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                event_id: `stub-${Date.now().toString(36)}`,
                title,
                start_iso,
                duration_minutes,
                attendees: attendees ?? [],
                _note:
                  'Stub tool — real implementation would call a calendar API. Real deployments would issue per-user gates by deriving `subject` from the calling agent identity.',
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
      purpose: 'agent_tool_call_mutation',
      // Higher-difficulty resource binding so the gate calibrates per-event.
      resource: ({ title, start_iso }) =>
        `tool:secure_calendar_write|date:${(start_iso as string).slice(0, 10)}|title_len:${(title as string).length}`,
      subject: 'anonymous_agent',
      issueParams: {
        target_solve_time_s: targetSolveTimeS,
        expires_in_s: 600,
      },
    },
  });
}
