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

  const flowsResponse = await client.getFlows();

  const existing = flowsResponse.flows.find((f) => f.id === parsed.nodeId);
  if (!existing) {
    throw new Error(`Node with id "${parsed.nodeId}" not found`);
  }

  const existingZ = (existing as Record<string, unknown>).z;
  if (existingZ !== undefined) {
    throw new Error(
      `Node "${parsed.nodeId}" has a z property and is flow-scoped — use the flow tools to delete it`
    );
  }

  if (isReferencedBy(flowsResponse.flows, parsed.nodeId)) {
    throw new Error(
      `Node "${parsed.nodeId}" is still referenced by other nodes and cannot be deleted`
    );
  }

  const updatedFlows = flowsResponse.flows.filter((f) => f.id !== parsed.nodeId);

  await client.putFlows({ ...flowsResponse, flows: updatedFlows }, 'nodes');

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ deleted: parsed.nodeId }, null, 2),
      },
    ],
  };
}
