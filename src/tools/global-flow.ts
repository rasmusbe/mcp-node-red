import { FlowsConflictError, type NodeRedClient } from '../client.js';
import type { NodeRedItem } from '../schemas.js';

/**
 * Apply a change to the whole Node-RED configuration under optimistic locking.
 *
 * The subflow and global config node tools all work the same way: read GET /flows, change one
 * item in the flat list, write the list back. POST /flows carries the rev the list was read at,
 * so a deploy from the editor in between is refused with 409 rather than silently overwritten.
 * One conflict is worth retrying, because the other deploy almost never touched the same item; a
 * second one means something is deploying continuously and the caller has to decide what to do.
 *
 * `mutate` runs again on that retry, against the configuration as it stands then, so it has to
 * derive everything from the list it is handed rather than from a list read earlier. Its own
 * errors mean the request cannot be satisfied at all and are passed through untouched.
 */
export async function modifyFlows(
  client: NodeRedClient,
  mutate: (flows: NodeRedItem[]) => NodeRedItem[]
): Promise<{ rev: string }> {
  try {
    return await applyOnce(client, mutate);
  } catch (error) {
    if (!(error instanceof FlowsConflictError)) {
      throw error;
    }
  }

  try {
    return await applyOnce(client, mutate);
  } catch (error) {
    if (error instanceof FlowsConflictError) {
      throw new Error(
        'The Node-RED configuration was deployed from elsewhere twice while this change was being applied, so nothing was written. Retry the call.'
      );
    }
    throw error;
  }
}

async function applyOnce(
  client: NodeRedClient,
  mutate: (flows: NodeRedItem[]) => NodeRedItem[]
): Promise<{ rev: string }> {
  const { rev, flows } = await client.getFlows();
  return await client.setFlows(mutate([...flows]), rev);
}

/**
 * The `z` of an item, when it has one. Items carry whatever keys Node-RED saved, so only the
 * node member of the union declares `z` and reading it off the union itself gives `unknown`.
 */
export function ownerId(item: NodeRedItem): string | undefined {
  const { z } = item as { z?: unknown };
  return typeof z === 'string' ? z : undefined;
}

/**
 * Which half of the nested view an item inside a tab or subflow belongs to. Node-RED splits them
 * on coordinates alone: parseConfig in runtime/lib/flows/util.js puts an item that has both x and
 * y in `nodes` and everything else in `configs`.
 */
export function isPositioned(item: NodeRedItem): boolean {
  const { x, y } = item as { x?: unknown; y?: unknown };
  return x !== undefined && y !== undefined;
}

/**
 * A global config node: an item that belongs to no tab or subflow and is not itself one. These
 * are the items GET /flow/global reports as its `configs`.
 */
export function isGlobalConfigNode(item: NodeRedItem): boolean {
  return ownerId(item) === undefined && item.type !== 'tab' && item.type !== 'subflow';
}
