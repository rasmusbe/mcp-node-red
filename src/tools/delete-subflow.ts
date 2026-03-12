import { z } from 'zod';
import type { NodeRedClient } from '../client.js';

const DeleteSubflowArgsSchema = z.object({
  subflowId: z.string(),
});

export async function deleteSubflow(client: NodeRedClient, args: unknown) {
  const parsed = DeleteSubflowArgsSchema.parse(args);

  const globalFlow = await client.getGlobalFlow();
  const subflows = globalFlow.subflows ?? [];

  if (!subflows.some((s) => s.id === parsed.subflowId)) {
    throw new Error(`Subflow with id "${parsed.subflowId}" not found`);
  }

  const updated = {
    ...globalFlow,
    subflows: subflows.filter((s) => s.id !== parsed.subflowId),
  };

  await client.updateGlobalFlow(updated);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ deleted: parsed.subflowId }, null, 2),
      },
    ],
  };
}
