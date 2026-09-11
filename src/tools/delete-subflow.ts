import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import type { NodeRedItem } from '../schemas.js';
import { modifyFlows, ownerId } from './global-flow.js';
import { textResult } from './result.js';

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

  const { rev } = await modifyFlows(client, (flows) => {
    if (!flows.some((item) => item.id === parsed.subflowId && item.type === 'subflow')) {
      throw new Error(`Subflow with id "${parsed.subflowId}" not found`);
    }

    const instances = findInstances(flows, parsed.subflowId);
    if (instances.length > 0) {
      throw new Error(
        `Subflow "${parsed.subflowId}" is still used by ${instances.length} instance node(s) (${instances.join(', ')}). Remove them first.`
      );
    }

    // The nodes inside the subflow have no other owner, so they go with the definition.
    return flows.filter(
      (item) => item.id !== parsed.subflowId && ownerId(item) !== parsed.subflowId
    );
  });

  return textResult({ deleted: parsed.subflowId, rev });
}
