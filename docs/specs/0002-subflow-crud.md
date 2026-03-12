# Subflow CRUD Tools

## Overview

Add four tools for managing subflow definitions in Node-RED. Subflows are reusable flow components — essentially named, parameterizable flow templates with declared input and output ports. They are stored in the global flow (`GET`/`PUT /flow/global`), separate from the tab-based flows managed by the existing flow tools.

## Background

The existing flow tools (`create_flow`, `update_flow`, `delete_flow`) operate on tab flows via `/flow/:id`. Subflows are a distinct concept in Node-RED: they live in the global flow object, are referenced by `type: "subflow:<id>"` nodes in other flows, and have a structural schema (named ports `in`/`out`, internal nodes, configs, env vars) that differs from regular flows.

Before this change, agents had no way to create, inspect, or modify subflows through MCP. Any attempt to use the flow tools on subflow data would fail or produce incorrect results because:

- Subflows are not retrievable via `GET /flows` by their id — they are part of `GET /flow/global`
- `POST /flow` and `PUT /flow/:id` do not accept `type: "subflow"` objects
- The existing `NodeRedItemSchema` and `UpdateFlowRequestSchema` did not model subflow fields (`name`, `in`, `out`), so Zod would strip them on parse

Additionally, `GET /flows` returns the full flows array which *does* include subflow definitions inline (Node-RED v4+ embeds them). The `NodeRedItemSchema` union did not include `NodeRedSubflowSchema`, causing parse failures when subflows were present in the response.

## Goals

- Add `get_subflows` — list all subflow definitions from the global flow
- Add `create_subflow` — add a new subflow to the global flow
- Add `update_subflow` — merge updates into an existing subflow by ID
- Add `delete_subflow` — remove a subflow from the global flow
- Extend schemas to correctly model subflow structure and include subflows in the `NodeRedItemSchema` union
- Extend `UpdateFlowRequestSchema` to preserve subflow fields (`name`, `in`, `out`, `env`) rather than stripping them

## Non-Goals

- **Subflow instance management** — nodes of `type: "subflow:<id>"` placed inside tab flows are managed via the existing `update_flow` tool, not these tools
- **Reference checking on delete** — unlike global config nodes, no reference check is performed when deleting a subflow. Node-RED itself handles orphaned subflow instances gracefully.
- **Port wiring validation** — the `in`/`out` port structures are passed through as-is; no validation of wire connections is performed

## Design

### Schema Extensions (`src/schemas.ts`)

Two new schemas and extensions to two existing ones:

```typescript
// Port descriptor for subflow inputs/outputs
export const NodeRedSubflowPortSchema = z
  .object({
    wires: z.array(z.object({ id: z.string(), port: z.number().optional() })).optional(),
  })
  .passthrough();

// Subflow definition
export const NodeRedSubflowSchema = z
  .object({
    id: z.string(),
    type: z.literal('subflow'),
    name: z.string(),
    info: z.string().optional(),
    in: z.array(NodeRedSubflowPortSchema).optional(),
    out: z.array(NodeRedSubflowPortSchema).optional(),
    nodes: z.array(NodeRedNodeSchema).optional(),
    configs: z.array(NodeRedConfigSchema).optional(),
    env: z.array(z.unknown()).optional(),
  })
  .passthrough();

// Global flow response from GET /flow/global
export const NodeRedGlobalFlowResponseSchema = z.object({
  id: z.literal('global'),
  configs: z.array(NodeRedConfigSchema).optional(),
  subflows: z.array(NodeRedSubflowSchema).optional(),
});
```

`NodeRedItemSchema` is extended from `union([NodeRedFlowSchema, NodeRedNodeSchema])` to `union([NodeRedFlowSchema, NodeRedSubflowSchema, NodeRedNodeSchema])` so that subflow definitions embedded in `GET /flows` responses parse correctly.

`UpdateFlowRequestSchema` is extended with `type`, `name`, `in`, `out`, `env` fields and converted to use `.passthrough()`, so that subflow data passed to flow update operations is preserved rather than stripped.

### Client Layer Extensions (`src/client.ts`)

Two new methods on `NodeRedClient`:

```typescript
async getGlobalFlow(): Promise<NodeRedGlobalFlowResponse> {
  // GET /flow/global → 200 with {id: "global", configs: [], subflows: [...]}
}

async updateGlobalFlow(flowData: NodeRedGlobalFlowResponse): Promise<{ id: string }> {
  // PUT /flow/global → 200 with {id: "global"} or 204
  // Body: full global flow object
}
```

Both follow the existing client pattern: status code check, body parse, error on unexpected status.

### Tool Implementations (`src/tools/`)

All four tools use the same read-modify-write pattern against `GET`/`PUT /flow/global`:

**`get-subflows.ts`**
- Calls `client.getGlobalFlow()`
- Returns `globalFlow.subflows ?? []`

**`create-subflow.ts`**
- Parses `subflow` JSON string, validates with `NodeRedSubflowSchema`
- Fetches global flow, checks for duplicate id
- Appends new subflow to `subflows` array, calls `updateGlobalFlow`
- Returns `{id}`

**`update-subflow.ts`**
- Parses `subflowId` and `updates` JSON string (partial update — merged with `Object.assign`)
- Fetches global flow, finds subflow by id, errors if not found
- Merges updates onto existing subflow (existing fields win for `id`)
- Calls `updateGlobalFlow`
- Returns `{id}`

**`delete-subflow.ts`**
- Parses `subflowId`
- Fetches global flow, errors if id not found
- Filters subflow out of the array, calls `updateGlobalFlow`
- Returns `{deleted: subflowId}`

### Server Registration (`src/server.ts`)

Four new entries in `ListToolsRequestSchema` and four new `case` branches in `CallToolRequestSchema`.

| Tool Name | Description | Input Schema |
|---|---|---|
| `get_subflows` | Get all subflow definitions from Node-RED. Subflows are reusable flow components stored in the global flow. | `{}` |
| `create_subflow` | Create a new subflow definition. The subflow is added to the global flow. | `{subflow: string}` |
| `update_subflow` | Update an existing subflow definition by ID. Only the specified subflow is modified. | `{subflowId: string, updates: string}` |
| `delete_subflow` | Delete a subflow definition from Node-RED by ID. Removes the subflow from the global flow. | `{subflowId: string}` |

The `subflow` and `updates` parameters are JSON strings following the existing project convention for flow parameters.

### Testing Strategy

**Client tests** (`tests/client.test.ts`):
- `getFlows`: verify subflows embedded in the flows array parse correctly via the extended `NodeRedItemSchema`
- `getGlobalFlow`: success with subflows array, error on non-200
- `updateGlobalFlow`: success (200 with body), success (204 no body → returns `{id: 'global'}`), error on non-200/204

**Tool tests** (`tests/tools.test.ts`):
- `getSubflows`: returns subflows array, returns empty array when none present
- `createSubflow`: success, duplicate id error, invalid JSON error
- `updateSubflow`: success with partial merge, not found error, invalid JSON error
- `deleteSubflow`: success, not found error

## Tasks

- [x] Add `NodeRedSubflowPortSchema` and `NodeRedSubflowSchema` to `src/schemas.ts`
- [x] Add `NodeRedGlobalFlowResponseSchema` to `src/schemas.ts`
- [x] Extend `NodeRedItemSchema` union to include `NodeRedSubflowSchema`
- [x] Extend `UpdateFlowRequestSchema` with `type`, `name`, `in`, `out`, `env` and add `.passthrough()`
- [x] Add `getGlobalFlow()` and `updateGlobalFlow()` methods to `src/client.ts`
- [x] Create `src/tools/get-subflows.ts`
- [x] Create `src/tools/create-subflow.ts`
- [x] Create `src/tools/update-subflow.ts`
- [x] Create `src/tools/delete-subflow.ts`
- [x] Register all four tools in `src/server.ts` (ListTools + CallTool)
- [x] Add client tests for `getGlobalFlow`, `updateGlobalFlow`, and subflow parsing in `getFlows`
- [x] Add tool handler tests for all four tools

## References

- [Node-RED: Creating Subflows](https://nodered.org/docs/user-guide/editor/workspace/subflows) — subflow concepts and usage
- [Node-RED Admin API: GET /flow/:id](https://nodered.org/docs/api/admin/methods/get/flow/) — global flow endpoint
- [Node-RED Admin API: PUT /flow/:id](https://nodered.org/docs/api/admin/methods/put/flow/) — global flow update endpoint
