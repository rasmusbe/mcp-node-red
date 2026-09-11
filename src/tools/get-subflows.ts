import type { NodeRedClient } from '../client.js';
import { textResult } from './result.js';

export async function getSubflows(client: NodeRedClient) {
  const globalFlow = await client.getGlobalFlow();

  return textResult(globalFlow.subflows ?? []);
}
