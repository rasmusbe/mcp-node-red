import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { NodeRedNodeSchema } from '../schemas.js';

const UpdateGlobalConfigNodeArgsSchema = z.object({
  nodeId: z.string(),
  node: z.string(),
});

export async function updateGlobalConfigNode(client: NodeRedClient, args: unknown) {
  const parsed = UpdateGlobalConfigNodeArgsSchema.parse(args);

  let nodeData: unknown;
  try {
    nodeData = JSON.parse(parsed.node);
  } catch (error) {
    throw new Error(
      `Invalid JSON in node parameter: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const validated = NodeRedNodeSchema.parse(nodeData);

  if (validated.z !== undefined) {
    throw new Error(
      'Replacement node must not have a z property — flow-scoped config nodes are managed by the flow tools'
    );
  }

  const flowsResponse = await client.getFlows();

  const existing = flowsResponse.flows.find((f) => f.id === parsed.nodeId);
  if (!existing) {
    throw new Error(`Node with id "${parsed.nodeId}" not found`);
  }

  const existingZ = (existing as Record<string, unknown>).z;
  if (existingZ !== undefined) {
    throw new Error(
      `Node "${parsed.nodeId}" has a z property and is flow-scoped — use the flow tools to update it`
    );
  }

  const updatedFlows = flowsResponse.flows.map((f) => (f.id === parsed.nodeId ? validated : f));

  await client.putFlows({ ...flowsResponse, flows: updatedFlows }, 'nodes');

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ id: validated.id }, null, 2),
      },
    ],
  };
}
