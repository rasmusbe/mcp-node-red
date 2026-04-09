import { z } from 'zod';
import type { NodeRedClient } from '../client.js';

const GetFlowArgsSchema = z.object({
  flowId: z.string(),
});

export async function getFlow(client: NodeRedClient, args: unknown) {
  const { flowId } = GetFlowArgsSchema.parse(args);
  const result = await client.getFlow(flowId);
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
