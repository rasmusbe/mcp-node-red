import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { type UpdateFlowRequest, UpdateFlowRequestSchema } from '../schemas.js';
import { parseJsonArgument } from './json-argument.js';
import { textResult } from './result.js';

const UpdateFlowArgsSchema = z.object({
  flowId: z.string(),
  updates: z.union([z.record(z.unknown()), z.string()]),
});

export async function updateFlow(client: NodeRedClient, args: unknown) {
  const parsed = UpdateFlowArgsSchema.parse(args);

  const flowData = parseJsonArgument(parsed.updates, 'updates');

  // Ensure id matches flowId parameter
  const updateData = {
    ...(typeof flowData === 'object' && flowData !== null ? flowData : {}),
    id: parsed.flowId,
  };

  // Validate the update, but send the object as it was given. Zod's passthrough emits the keys a
  // schema declares before the rest, so a parsed copy would rewrite the key order of every node
  // in the flow, which is churn in flows.json for a caller that round-tripped it from get_flow.
  UpdateFlowRequestSchema.parse(updateData);

  const result = await client.updateFlow(parsed.flowId, updateData as UpdateFlowRequest);

  return textResult(result);
}
