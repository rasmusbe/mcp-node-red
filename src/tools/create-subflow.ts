import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { NodeRedSubflowSchema } from '../schemas.js';
import { parseJsonArgument } from './json-argument.js';
import { textResult } from './result.js';

const CreateSubflowArgsSchema = z.object({
  subflow: z.union([z.record(z.unknown()), z.string()]),
});

export async function createSubflow(client: NodeRedClient, args: unknown) {
  const parsed = CreateSubflowArgsSchema.parse(args);

  const subflowData = parseJsonArgument(parsed.subflow, 'subflow');

  const validated = NodeRedSubflowSchema.parse(subflowData);

  const globalFlow = await client.getGlobalFlow();
  const subflows = globalFlow.subflows ?? [];

  if (subflows.some((s) => s.id === validated.id)) {
    throw new Error(`Subflow with id "${validated.id}" already exists`);
  }

  const updated = { ...globalFlow, subflows: [...subflows, validated] };
  await client.updateGlobalFlow(updated);

  return textResult({ id: validated.id });
}
