import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import type { NodeRedItem } from '../schemas.js';

const DeleteGlobalConfigNodeArgsSchema = z.object({
  nodeId: z.string(),
});

/**
 * Which property holds a config node reference varies by node type, and some nodes keep them
 * inside nested objects or arrays of objects (rule lists, credential maps, subflow env entries).
 * Anything short of a full search deletes a config node that is still wired up somewhere.
 */
function containsReference(value: unknown, nodeId: string): boolean {
  if (typeof value === 'string') {
    return value === nodeId;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsReference(entry, nodeId));
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((entry) => containsReference(entry, nodeId));
  }
  return false;
}

function isReferencedBy(flows: NodeRedItem[], nodeId: string): boolean {
  return flows.some((item) => {
    if (item.id === nodeId) {
      return false;
    }
    // The node's own top-level id is what identifies it, not a reference to itself.
    return Object.entries(item as Record<string, unknown>).some(
      ([key, value]) => key !== 'id' && containsReference(value, nodeId)
    );
  });
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
