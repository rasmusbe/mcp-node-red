import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import type { NodeRedItem } from '../schemas.js';

const DeleteGlobalConfigNodeArgsSchema = z.object({
  nodeId: z.string(),
});

function isReferencedBy(flows: NodeRedItem[], nodeId: string): boolean {
  for (const item of flows) {
    if (item.id === nodeId) continue;
    const obj = item as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'id') continue;
      if (value === nodeId) return true;
      if (Array.isArray(value) && value.some((v) => v === nodeId)) return true;
    }
  }
  return false;
}

export async function deleteGlobalConfigNode(client: NodeRedClient, args: unknown) {
  const parsed = DeleteGlobalConfigNodeArgsSchema.parse(args);

  const globalFlow = await client.getGlobalFlow();
  const configs = globalFlow.configs ?? [];

  if (!configs.some((c) => c.id === parsed.nodeId)) {
    throw new Error(`Node with id "${parsed.nodeId}" not found`);
  }

  const flowsResponse = await client.getFlows();
  if (isReferencedBy(flowsResponse.flows, parsed.nodeId)) {
    throw new Error(
      `Node "${parsed.nodeId}" is still referenced by other nodes and cannot be deleted`
    );
  }

  await client.updateGlobalFlow({
    ...globalFlow,
    configs: configs.filter((c) => c.id !== parsed.nodeId),
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ deleted: parsed.nodeId }, null, 2),
      },
    ],
  };
}
