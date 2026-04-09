# Global Config Node Management

## Overview

Add three tools for creating, updating, and deleting global config nodes — nodes with no `z` property that are accessible from all flows. These fill a gap left by the existing flow tools, which handle flow-scoped config nodes but have no way to manage the global ones that Node-RED requires for shared infrastructure like MQTT brokers, TLS configs, and credential stores.

## Background

Node-RED has two kinds of config nodes:

**Flow-scoped config nodes** have a `z` property pointing to their parent tab. They are created and deleted via `POST /flow` and `PUT /flow/:id` as part of the flow's `configs` array. The existing `create_flow` and `update_flow` tools handle these correctly.

**Global config nodes** have no `z` property. They are accessible from any flow and stored in the `configs` array of the global flow object (`GET`/`PUT /flow/global`). Examples: `mqtt-broker`, `tls-config`, `credentials`.

The existing flow tools cannot create or remove global config nodes. This means agents setting up multi-flow workflows that share infrastructure — e.g. multiple MQTT flows pointing to the same broker config — have no way to manage that shared config through MCP.

## Goals

- Add `create_global_config_node` — append a new global config node to the global flow's `configs`
- Add `update_global_config_node` — replace an existing global config node by ID
- Add `delete_global_config_node` — remove a global config node, with a reference check
- Error clearly when flow-scoped nodes (those with `z`) are passed to these tools

## Non-Goals

- **Bulk flow replacement** — these tools make targeted changes to `globalFlow.configs` only; all other flows and subflows are untouched.
- **Flow-scoped config node management** — already handled by `create_flow` / `update_flow` via the `configs` array. These tools reject any node that has a `z` property.
- **Config node validation** — type-specific field validation (e.g. checking that `host` is present on an `mqtt-broker` node) is not performed. Node-RED will reject invalid nodes on deploy.

## Design

### Client Layer

No new client methods are needed. Global config nodes are stored in the `configs` array of the global flow object, managed via the existing `getGlobalFlow` / `updateGlobalFlow` methods (which use `GET`/`PUT /flow/global`) already added for subflow support.

All three tools use the same read-modify-write pattern:
1. `client.getGlobalFlow()` — fetch `{id: 'global', configs: [...], subflows: [...]}`
2. Modify the `configs` array (add / replace / remove)
3. `client.updateGlobalFlow({...globalFlow, configs: modified})` — deploy

The `delete` tool additionally calls `client.getFlows()` to check for references across all tab flows before removing the node.

### Tool Implementations (`src/tools/`)

**`create-global-config-node.ts`**
- Parses `node` JSON string, validates with `NodeRedNodeSchema`
- Errors if `node.z` is defined (flow-scoped — use flow tools)
- Calls `getGlobalFlow`, errors if a node with that `id` already exists in `configs`
- Appends to `configs` and calls `updateGlobalFlow`
- Returns `{id}`

**`update-global-config-node.ts`**
- Parses `nodeId` and `node` JSON string, validates replacement with `NodeRedNodeSchema`
- Errors if replacement has `z` (would make it flow-scoped)
- Calls `getGlobalFlow`, errors if `nodeId` not found in `configs`
- Replaces the node in `configs` and calls `updateGlobalFlow`
- Returns `{id}`

**`delete-global-config-node.ts`**
- Parses `nodeId`
- Calls `getGlobalFlow`, errors if `nodeId` not found in `configs`
- Calls `getFlows` to scan all tab flows; errors if any node has a property value equal to `nodeId`
- Removes the node from `configs` and calls `updateGlobalFlow`
- Returns `{deleted: nodeId}`

### Reference Check (delete)

Config node references in Node-RED are stored as string property values on other nodes. For example, an `mqtt in` node stores its broker config ID in a `broker` field. There is no fixed schema for which field holds the reference — it varies by node type.

The delete tool does a generic scan: for every other node in the flows array, check if any non-`id` property (string or array element) equals the target `nodeId`. This is the same approach used by the Node-RED editor when preventing config node deletion.

### Server Registration (`src/server.ts`)

Three new entries in `ListToolsRequestSchema` and three new `case` branches in `CallToolRequestSchema`.

| Tool Name | Description | Input Schema |
|---|---|---|
| `create_global_config_node` | Create a new global config node accessible from all flows. Uses `PUT /flow/global`. | `{node: string}` |
| `update_global_config_node` | Replace an existing global config node by ID. Uses `PUT /flow/global`. | `{nodeId: string, node: string}` |
| `delete_global_config_node` | Delete a global config node. Errors if still referenced by other nodes. Uses `PUT /flow/global`. | `{nodeId: string}` |

All three tools error (via the standard MCP error response) when:
- The node (or the node found by `nodeId`) has a `z` property
- The node is not found (update, delete)
- The node ID already exists (create)
- The node is still referenced by another node (delete)

### Testing Strategy

Tests follow the existing pattern with a mocked `NodeRedClient`.

**Tool tests** (`tests/tools.test.ts`):
- `createGlobalConfigNode`: success, duplicate id error, z property error, invalid JSON
- `updateGlobalConfigNode`: success, not found error, replacement has z error, invalid JSON
- `deleteGlobalConfigNode`: success, not found error, referenced node error

## Tasks

- [x] Create `src/tools/create-global-config-node.ts`
- [x] Create `src/tools/update-global-config-node.ts`
- [x] Create `src/tools/delete-global-config-node.ts`
- [x] Register all three tools in `src/server.ts` (ListTools + CallTool)
- [x] Add tool handler tests in `tests/tools.test.ts`

## References

- [Node-RED Admin API: GET /flow/:id](https://nodered.org/docs/api/admin/methods/get/flow/) — global flow endpoint (`/flow/global`)
- [Node-RED Admin API: PUT /flow/:id](https://nodered.org/docs/api/admin/methods/put/flow/) — global flow update endpoint (`/flow/global`)
- [Node-RED Config Nodes](https://nodered.org/docs/creating-nodes/config-nodes) — how config nodes work and the z property convention
