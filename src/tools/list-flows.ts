import type { NodeRedClient } from '../client.js';
import { textResult } from './result.js';

export async function listFlows(client: NodeRedClient) {
  const result = await client.getFlows();
  const tabs = result.flows
    .filter((item) => item.type === 'tab')
    .map((item) => ({ id: item.id, label: (item as { label?: string }).label, type: item.type }));
  return textResult(tabs);
}
