import type { NodeRedClient } from '../client.js';
import { textResult } from './result.js';

export async function listFlows(client: NodeRedClient) {
  const tabs = await client.listTabs();

  // Every item is a tab, so the type says nothing; disabled only appears when it is true.
  return textResult(
    tabs.map((tab) => ({
      id: tab.id,
      label: tab.label,
      ...(tab.disabled ? { disabled: true } : {}),
    }))
  );
}
