import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { textResult } from './result.js';

const SetDebugStateArgsSchema = z.object({
  nodeId: z.string(),
  enabled: z.boolean(),
});

export async function setDebugState(client: NodeRedClient, args: unknown) {
  const parsed = SetDebugStateArgsSchema.parse(args);

  await client.setDebugNodeState(parsed.nodeId, parsed.enabled);

  return textResult({ nodeId: parsed.nodeId, enabled: parsed.enabled });
}
