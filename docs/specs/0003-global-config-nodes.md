# Global Config Node Management

## Overview

Add three tools for creating, updating, and deleting global config nodes — nodes with no `z` property that are accessible from all flows. These fill a gap left by the existing flow tools, which handle flow-scoped config nodes but have no way to manage the global ones that Node-RED requires for shared infrastructure like MQTT brokers, TLS configs, and credential stores.

## Background

Node-RED has two kinds of config nodes:

**Flow-scoped config nodes** have a `z` property pointing to their parent tab. They are created and deleted via `POST /flow` and `PUT /flow/:id` as part of the flow's `configs` array. The existing `create_flow` and `update_flow` tools handle these correctly.

**Global config nodes** have no `z` property. They live in the flat flows array at the top level, accessible from any flow. Examples: `mqtt-broker`, `tls-config`, `credentials`. The Node-RED editor creates and deletes them via `PUT /flows` (full deploy), which is the only Admin API endpoint that can modify the top-level flows array directly.

The existing flow tools cannot create or remove global config nodes. This means agents setting up multi-flow workflows that share infrastructure — e.g. multiple MQTT flows pointing to the same broker config — have no way to manage that shared config through MCP.

## Goals

- Add `create_global_config_node` — append a new global config node to the flows array
- Add `update_global_config_node` — replace an existing global config node by ID
- Add `delete_global_config_node` — remove a global config node, with a reference check
- Expose a safe, scoped surface over `PUT /flows` without giving agents the ability to wipe all flows
- Error clearly when flow-scoped nodes (those with `z`) are passed to these tools

## Non-Goals

- **Bulk flow replacement** — `PUT /flows` is used internally with `Node-RED-Deployment-Type: nodes`, but is never exposed as a raw tool. Agents cannot replace all flows at once.
- **Flow-scoped config node management** — already handled by `create_flow` / `update_flow` via the `configs` array. These tools reject any node that has a `z` property.
- **Config node validation** — type-specific field validation (e.g. checking that `host` is present on an `mqtt-broker` node) is not performed. Node-RED will reject invalid nodes on deploy.

## Design

### Client Layer Extension (`src/client.ts`)

A single new method wraps `PUT /flows` with the `Node-RED-Deployment-Type: nodes` header. This deployment type tells Node-RED to only redeploy nodes that have changed, rather than restarting everything.

```typescript
async putFlows(
  flowsData: NodeRedFlowsResponse,
  deploymentType: 'full' | 'flows' | 'nodes' = 'full'
): Promise<void> {
  // PUT /flows with Node-RED-Deployment-Type header
  // Body: {rev: "...", flows: [...]}
  // Response: 200 or 204 (body consumed but ignored — rev is taken from getFlows)
}
```

All three tools use the same read-modify-write pattern:
1. `client.getFlows()` — fetch current `{rev, flows}`
2. Modify the flows array (add / replace / remove)
3. `client.putFlows({rev, flows: modified}, 'nodes')` — deploy

The `rev` from step 1 is passed back in step 3 for optimistic locking.

### Tool Implementations (`src/tools/`)

**`create-global-config-node.ts`**
- Parses `node` JSON string, validates with `NodeRedNodeSchema`
- Errors if `node.z` is defined (flow-scoped — use flow tools)
- Errors if a node with that `id` already exists in the flows array
- Appends to flows array and calls `putFlows`
- Returns `{id}`

**`update-global-config-node.ts`**
- Parses `nodeId` and `node` JSON string, validates replacement with `NodeRedNodeSchema`
- Errors if replacement has `z` (would make it flow-scoped)
- Finds existing node by `nodeId`, errors if not found
- Errors if existing node has `z` (flow-scoped — use flow tools)
- Replaces the node in the flows array and calls `putFlows`
- Returns `{id}`

**`delete-global-config-node.ts`**
- Parses `nodeId`
- Finds node by `nodeId`, errors if not found
- Errors if existing node has `z` (flow-scoped — use flow tools)
- Scans all other nodes for any property value equal to `nodeId` (including array properties); errors if referenced
- Removes the node and calls `putFlows`
- Returns `{deleted: nodeId}`

### Reference Check (delete)

Config node references in Node-RED are stored as string property values on other nodes. For example, an `mqtt in` node stores its broker config ID in a `broker` field. There is no fixed schema for which field holds the reference — it varies by node type.

The delete tool does a generic scan: for every other node in the flows array, check if any non-`id` property (string or array element) equals the target `nodeId`. This is the same approach used by the Node-RED editor when preventing config node deletion.

### Server Registration (`src/server.ts`)

Three new entries in `ListToolsRequestSchema` and three new `case` branches in `CallToolRequestSchema`.

| Tool Name | Description | Input Schema |
|---|---|---|
| `create_global_config_node` | Create a new global config node accessible from all flows. Uses `PUT /flows` with `Node-RED-Deployment-Type: nodes`. | `{node: string}` |
| `update_global_config_node` | Replace an existing global config node by ID. Uses `PUT /flows` with `Node-RED-Deployment-Type: nodes`. | `{nodeId: string, node: string}` |
| `delete_global_config_node` | Delete a global config node. Errors if still referenced by other nodes. Uses `PUT /flows` with `Node-RED-Deployment-Type: nodes`. | `{nodeId: string}` |

All three tools error (via the standard MCP error response) when:
- The node (or the node found by `nodeId`) has a `z` property
- The node is not found (update, delete)
- The node ID already exists (create)
- The node is still referenced by another node (delete)

### Testing Strategy

Tests follow the existing pattern with a mocked `NodeRedClient`.

**Tool tests** (`tests/tools.test.ts`):
- `createGlobalConfigNode`: success, duplicate id error, z property error, invalid JSON
- `updateGlobalConfigNode`: success, not found error, existing node has z error, replacement has z error, invalid JSON
- `deleteGlobalConfigNode`: success, not found error, z property error, referenced node error

## Tasks

- [x] Add `putFlows(flowsData, deploymentType)` method to `src/client.ts`
- [x] Create `src/tools/create-global-config-node.ts`
- [x] Create `src/tools/update-global-config-node.ts`
- [x] Create `src/tools/delete-global-config-node.ts`
- [x] Register all three tools in `src/server.ts` (ListTools + CallTool)
- [x] Add tool handler tests in `tests/tools.test.ts`

## References

- [Node-RED Admin API: PUT /flows](https://nodered.org/docs/api/admin/methods/put/flows/) — full flows deployment endpoint
- [Node-RED Deployment Types](https://nodered.org/docs/api/admin/methods/put/flows/) — `full`, `flows`, `nodes` deployment type semantics
- [Node-RED Config Nodes](https://nodered.org/docs/creating-nodes/config-nodes) — how config nodes work and the z property convention
