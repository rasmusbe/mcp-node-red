import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { type NodeRedItem, NodeRedSubflowSchema } from '../schemas.js';
import { isPositioned, modifyFlows, ownerId } from './global-flow.js';
import { parseJsonArgument } from './json-argument.js';
import { textResult } from './result.js';

const UpdateSubflowArgsSchema = z.object({
  subflowId: z.string(),
  updates: z.union([z.record(z.unknown()), z.string()]),
});

export async function updateSubflow(client: NodeRedClient, args: unknown) {
  const parsed = UpdateSubflowArgsSchema.parse(args);

  const updateData = parseJsonArgument(parsed.updates, 'updates');
  const updates =
    typeof updateData === 'object' && updateData !== null
      ? (updateData as Record<string, unknown>)
      : {};

  // A list that is sent replaces the subflow's contents of that kind; one that is left out
  // leaves them alone, so an update to the name does not have to echo every inner node back.
  const replacesNodes = 'nodes' in updates;
  const replacesConfigs = 'configs' in updates;
  const { nodes: updatedNodes, configs: updatedConfigs, ...patch } = updates;

  const { rev } = await modifyFlows(client, (flows) => {
    const current = flows.find((item) => item.id === parsed.subflowId && item.type === 'subflow');

    if (!current) {
      throw new Error(`Subflow with id "${parsed.subflowId}" not found`);
    }

    const inner = flows.filter((item) => ownerId(item) === parsed.subflowId);

    // Validate the merged result, not just the incoming patch. The write replaces the definition
    // with what is sent, so an update that drops name or changes type writes a definition the
    // next read cannot parse, leaving the subflow tools unusable. Only the check is wanted: the
    // parsed copy would reorder the keys of items that are already in flows.json, because Zod's
    // passthrough emits the keys a schema declares before the rest.
    NodeRedSubflowSchema.parse({
      ...current,
      ...updates,
      id: parsed.subflowId,
      type: 'subflow',
      nodes: replacesNodes ? updatedNodes : inner.filter(isPositioned),
      configs: replacesConfigs ? updatedConfigs : inner.filter((item) => !isPositioned(item)),
    });

    const definition = {
      ...current,
      ...patch,
      id: parsed.subflowId,
      type: 'subflow',
    } as NodeRedItem;

    const replacements = [
      ...(replacesNodes ? (updatedNodes as NodeRedItem[]) : []),
      ...(replacesConfigs ? (updatedConfigs as NodeRedItem[]) : []),
    ].map((item) => ({ ...item, z: parsed.subflowId }));

    const kept = flows
      .map((item) => (item === current ? definition : item))
      .filter((item) => {
        if (ownerId(item) !== parsed.subflowId) {
          return true;
        }
        return isPositioned(item) ? !replacesNodes : !replacesConfigs;
      });

    return [...kept, ...replacements];
  });

  return textResult({ id: parsed.subflowId, rev });
}
