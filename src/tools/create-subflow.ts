import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { NodeRedSubflowSchema } from '../schemas.js';
import { modifyFlows } from './global-flow.js';
import { parseJsonArgument } from './json-argument.js';
import { textResult } from './result.js';

const CreateSubflowArgsSchema = z.object({
  subflow: z.union([z.record(z.unknown()), z.string()]),
});

export async function createSubflow(client: NodeRedClient, args: unknown) {
  const parsed = CreateSubflowArgsSchema.parse(args);

  const subflowData = parseJsonArgument(parsed.subflow, 'subflow');

  const validated = NodeRedSubflowSchema.parse(subflowData);

  // The subflow is written as one flat item plus its contents as ordinary items whose z names
  // the subflow, the same way a node on a tab points at the tab. The nested shape the tool takes
  // is what GET /flow/global reports, not what the configuration stores.
  const { nodes = [], configs = [], ...definition } = validated;
  const inner = [...nodes, ...configs].map((item) => ({ ...item, z: validated.id }));

  const { rev } = await modifyFlows(client, (flows) => {
    const taken = new Set(flows.map((item) => item.id));

    if (taken.has(validated.id)) {
      throw new Error(`Subflow with id "${validated.id}" already exists`);
    }

    // Ids are unique across the whole configuration, not per subflow: a reused id would replace
    // an unrelated node when Node-RED indexes the list.
    for (const item of inner) {
      if (taken.has(item.id)) {
        throw new Error(`Node with id "${item.id}" already exists in the configuration`);
      }
      taken.add(item.id);
    }

    return [...flows, definition, ...inner];
  });

  return textResult({ id: validated.id, rev });
}
