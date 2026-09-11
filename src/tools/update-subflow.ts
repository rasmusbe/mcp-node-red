import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { NodeRedSubflowSchema } from '../schemas.js';
import { parseJsonArgument } from './json-argument.js';
import { textResult } from './result.js';

const UpdateSubflowArgsSchema = z.object({
  subflowId: z.string(),
  updates: z.union([z.record(z.unknown()), z.string()]),
});

export async function updateSubflow(client: NodeRedClient, args: unknown) {
  const parsed = UpdateSubflowArgsSchema.parse(args);

  const updateData = parseJsonArgument(parsed.updates, 'updates');

  const globalFlow = await client.getGlobalFlow();
  const subflows = globalFlow.subflows ?? [];
  const index = subflows.findIndex((s) => s.id === parsed.subflowId);

  if (index === -1) {
    throw new Error(`Subflow with id "${parsed.subflowId}" not found`);
  }

  // Validate the merged result, not just the incoming patch. PUT /flow/global replaces every
  // subflow with what is sent, so an update that drops name or changes type writes a broken
  // definition that the next read cannot parse, leaving the subflow tools unusable.
  const merged = NodeRedSubflowSchema.parse({
    ...subflows[index],
    ...(typeof updateData === 'object' && updateData !== null ? updateData : {}),
    id: parsed.subflowId,
    type: 'subflow',
  });

  const updatedSubflows = [...subflows];
  updatedSubflows[index] = merged;

  await client.updateGlobalFlow({ ...globalFlow, subflows: updatedSubflows });

  return textResult({ id: parsed.subflowId });
}
