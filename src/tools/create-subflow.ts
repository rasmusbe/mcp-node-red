import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { NodeRedSubflowSchema } from '../schemas.js';

const CreateSubflowArgsSchema = z.object({
  subflow: z.string(),
});

export async function createSubflow(client: NodeRedClient, args: unknown) {
  const parsed = CreateSubflowArgsSchema.parse(args);

  let subflowData: unknown;
  try {
    subflowData = JSON.parse(parsed.subflow);
  } catch (error) {
    throw new Error(
      `Invalid JSON in subflow parameter: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const validated = NodeRedSubflowSchema.parse(subflowData);

  const globalFlow = await client.getGlobalFlow();
  const subflows = globalFlow.subflows ?? [];

  if (subflows.some((s) => s.id === validated.id)) {
    throw new Error(`Subflow with id "${validated.id}" already exists`);
  }

  const updated = { ...globalFlow, subflows: [...subflows, validated] };
  await client.updateGlobalFlow(updated);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ id: validated.id }, null, 2),
      },
    ],
  };
}
