import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { UpdateFlowRequestSchema } from '../schemas.js';
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

  const validated = UpdateFlowRequestSchema.parse(updateData);

  const result = await client.updateFlow(parsed.flowId, validated);

  return textResult(result);
}
