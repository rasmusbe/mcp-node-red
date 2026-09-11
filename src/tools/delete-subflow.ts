import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import type { NodeRedItem } from '../schemas.js';

const DeleteSubflowArgsSchema = z.object({
  subflowId: z.string(),
});

/**
 * A subflow is placed in a flow as an instance node of type "subflow:<id>". Deleting the
 * definition while instances remain leaves those nodes pointing at a type Node-RED no longer
 * knows, so refuse it the way the editor does.
 */
function findInstances(flows: NodeRedItem[], subflowId: string): string[] {
  return flows.filter((item) => item.type === `subflow:${subflowId}`).map((item) => item.id);
}

export async function deleteSubflow(client: NodeRedClient, args: unknown) {
  const parsed = DeleteSubflowArgsSchema.parse(args);

  const globalFlow = await client.getGlobalFlow();
  const subflows = globalFlow.subflows ?? [];

  if (!subflows.some((s) => s.id === parsed.subflowId)) {
    throw new Error(`Subflow with id "${parsed.subflowId}" not found`);
  }

  const flowsResponse = await client.getFlows();
  const instances = findInstances(flowsResponse.flows, parsed.subflowId);
  if (instances.length > 0) {
    throw new Error(
      `Subflow "${parsed.subflowId}" is still used by ${instances.length} instance node(s) (${instances.join(', ')}). Remove them first.`
    );
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
