import { z } from 'zod';
import type { NodeRedClient } from '../client.js';

const UpdateSubflowArgsSchema = z.object({
  subflowId: z.string(),
  updates: z.string(),
});

export async function updateSubflow(client: NodeRedClient, args: unknown) {
  const parsed = UpdateSubflowArgsSchema.parse(args);

  let updateData: unknown;
  try {
    updateData = JSON.parse(parsed.updates);
  } catch (error) {
    throw new Error(
      `Invalid JSON in updates parameter: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const globalFlow = await client.getGlobalFlow();
  const subflows = globalFlow.subflows ?? [];
  const index = subflows.findIndex((s) => s.id === parsed.subflowId);

  if (index === -1) {
    throw new Error(`Subflow with id "${parsed.subflowId}" not found`);
  }

  const updatedSubflows = [...subflows];
  updatedSubflows[index] = {
    ...subflows[index],
    ...(typeof updateData === 'object' && updateData !== null ? updateData : {}),
    id: parsed.subflowId,
  };

  await client.updateGlobalFlow({ ...globalFlow, subflows: updatedSubflows });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ id: parsed.subflowId }, null, 2),
      },
    ],
  };
}
