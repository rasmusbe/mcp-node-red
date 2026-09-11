import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { textResult } from './result.js';

const SetFlowStateArgsSchema = z.object({
  state: z.enum(['start', 'stop']),
});

export async function setFlowState(client: NodeRedClient, args: unknown) {
  const parsed = SetFlowStateArgsSchema.parse(args);
  const result = await client.setFlowState(parsed.state);
  return textResult(result);
}
