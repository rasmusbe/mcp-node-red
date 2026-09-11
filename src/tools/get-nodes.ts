import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { textResult } from './result.js';

/**
 * GET /nodes answers with one flat entry per node set, each repeating the module fields it
 * belongs to. NodeModuleSchema describes a different shape and only accepts these because it
 * passes unknown keys through, so read the fields that are really there.
 */
const NodeSetListSchema = z.array(
  z
    .object({
      id: z.string(),
      name: z.string().optional(),
      types: z.array(z.string()).optional(),
      enabled: z.boolean().optional(),
      module: z.string().optional(),
      version: z.string().optional(),
      local: z.boolean().optional(),
      user: z.boolean().optional(),
    })
    .passthrough()
);

type NodeSetEntry = z.infer<typeof NodeSetListSchema>[number];

interface ModuleGroup {
  module: string;
  version?: string;
  local?: boolean;
  user?: boolean;
  sets: Map<string, Set<string>>;
  disabledSets: string[];
}

/** Set ids are "<module>/<set>", and a scoped module name contains slashes of its own. */
function splitId(id: string): { module: string; set: string } {
  const separator = id.lastIndexOf('/');
  return separator === -1
    ? { module: id, set: id }
    : { module: id.slice(0, separator), set: id.slice(separator + 1) };
}

function add(groups: Map<string, ModuleGroup>, entry: NodeSetEntry): void {
  const fromId = splitId(entry.id);
  const module = entry.module ?? fromId.module;
  const name = entry.name ?? fromId.set;

  let group = groups.get(module);
  if (!group) {
    group = { module, sets: new Map(), disabledSets: [] };
    groups.set(module, group);
  }

  group.version ??= entry.version;
  group.local ??= entry.local;
  group.user ??= entry.user;

  // A node set can register the same type more than once, and one core module does.
  const types = group.sets.get(name) ?? new Set<string>();
  for (const type of entry.types ?? []) {
    types.add(type);
  }
  group.sets.set(name, types);

  if (entry.enabled === false) {
    group.disabledSets.push(name);
  }
}

export async function getNodes(client: NodeRedClient) {
  const entries = NodeSetListSchema.parse(await client.getNodes());

  const groups = new Map<string, ModuleGroup>();
  for (const entry of entries) {
    add(groups, entry);
  }

  const modules = [...groups.values()].map((group) => {
    // Naming the disabled sets only matters while the module is mixed: with every set disabled
    // the module-level false already says it.
    const mixed = group.disabledSets.length > 0 && group.disabledSets.length < group.sets.size;

    return {
      module: group.module,
      version: group.version,
      local: group.local,
      user: group.user,
      enabled: group.disabledSets.length === 0,
      sets: Object.fromEntries([...group.sets].map(([name, types]) => [name, [...types]])),
      ...(mixed ? { disabledSets: group.disabledSets } : {}),
    };
  });

  return textResult(modules);
}
