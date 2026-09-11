import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { textResult } from './result.js';

const TriggerInjectArgsSchema = z.object({
  nodeId: z.string(),
});

export async function triggerInject(client: NodeRedClient, args: unknown) {
  const parsed = TriggerInjectArgsSchema.parse(args);

  await client.triggerInject(parsed.nodeId);

  return textResult({ nodeId: parsed.nodeId, triggered: true });
}
