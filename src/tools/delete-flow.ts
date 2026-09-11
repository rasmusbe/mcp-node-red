import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { textResult } from './result.js';

const DeleteFlowArgsSchema = z.object({
  flowId: z.string(),
});

export async function deleteFlow(client: NodeRedClient, args: unknown) {
  const parsed = DeleteFlowArgsSchema.parse(args);

  await client.deleteFlow(parsed.flowId);

  return textResult({ deleted: parsed.flowId });
}
