import type { NodeRedClient } from '../client.js';
import { textResult } from './result.js';

export async function getFlowState(client: NodeRedClient) {
  const result = await client.getFlowState();
  return textResult(result);
}
