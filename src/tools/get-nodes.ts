import type { NodeRedClient } from '../client.js';
import type { NodeSet } from '../schemas.js';
import { textResult } from './result.js';

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

function add(groups: Map<string, ModuleGroup>, entry: NodeSet): void {
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
  const groups = new Map<string, ModuleGroup>();
  for (const entry of await client.getNodes()) {
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
