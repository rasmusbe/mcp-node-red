# Hardening and Token Efficiency

## Overview

A series of batches that make the server harder to break (timeouts, cancellation, encoding,
bounded error output) and cheaper to talk to (compact responses, partial flow reads and writes,
fewer round trips). Each batch lands as one commit on main.

## Background

The tools were built endpoint by endpoint against the Admin API, and the gaps that are left are
mostly in the seams: undici's 300 second default timeouts, path segments interpolated without
encoding, whole HTML error pages pasted into error messages, and pretty-printed JSON in every
response. Nothing here changes what the tools are for; it changes how they behave when Node-RED,
the network or the caller misbehaves, and how much of the context window a call costs.

## Tasks

### Batch 1, stability

- [x] `create_flow` accepts a flow without id; id comes back from Node-RED
- [x] HTTP timeouts via a shared undici `Agent`, and MCP request cancellation reaches undici
- [x] URL-encode path segments in `getContext`, `deleteContext`, `triggerInject`,
      `setDebugNodeState`, `setNodeModuleState`, `removeNodeModule`
- [x] Error responses from Node-RED are truncated and, when JSON, reduced to their message
- [x] `delete_global_config_node` reference check searches nested values
- [x] Server version read from `package.json`

### Batch 2, token usage (small)

- [x] Compact JSON in all tool responses via one shared helper
- [x] Zod validation errors rendered one line per issue
- [x] `get_nodes` output grouped per module

### Batch 3, token usage (large)

- [x] `patch_flow` tool for partial flow updates (add, replace, remove nodes, label, disabled)
- [x] `get_flow` selection parameters (`nodeIds`, `types`, `summary`)
- [x] Flow, subflow and config node parameters accepted as objects, strings still tolerated

### Batch 4, schema and speed

- [ ] `NodeSetSchema` that matches `GET /nodes`; remove the duplicate parse in `get_node_help`
- [ ] Node set cache in the client, invalidated by `install_node`, `remove_node_module`,
      `set_node_module_state`
- [ ] Lightweight schema for `list_flows`
- [ ] Parallel fetches in `delete_subflow` and `delete_global_config_node`
- [ ] One retry on `ECONNREFUSED`/`ECONNRESET` for GET requests
- [ ] `validate_flow` checks wires, `z` and installed node types

### Batch 5, get_node_help

- [ ] Help HTML rendered as markdown
- [ ] Configurable properties read from the node's `defaults` in `RED.nodes.registerType`

### Batch 6, optimistic locking

Decided 2026-09-11: global flow writes move to `POST /flows` with `rev`, so a concurrent editor
deploy answers 409 instead of being overwritten. Hiding `get_flow_state` and `set_flow_state`
when `runtimeState` is disabled was considered and declined: it saves about 700 characters per
session and makes startup depend on Node-RED answering.

- [ ] Optimistic locking with `rev` for global flow writes (subflow and global config node tools)

## Design (batch 1)

**create_flow without id.** `POST /flow` generates an id when none is sent, but the tool
validated its input with `UpdateFlowRequestSchema`, whose `id` is required, so the documented
auto-generation was unreachable. `CreateFlowRequestSchema` makes `id` optional; the client reads
the generated id from the 200 body, falls back to the id it sent on a 204, and errors clearly
when neither is available.

**Timeouts and cancellation.** One module-level `Agent` carries a 5 s connect timeout and 30 s
header and body timeouts, replacing undici's 300 s defaults. `installNode` overrides both to
300 s per request because it runs npm inside Node-RED. `NodeRedClient.withSignal` returns a view
of the client bound to the `AbortSignal` the MCP SDK passes to each request handler, so a
cancelled call aborts the HTTP request instead of running to completion.

**Encoding.** Context ids and keys and node ids are single path segments and are now
percent-encoded. Module names go through `encodeNodePath`, which keeps the literal slash and `@`
that Node-RED's `/nodes/:module/:set` route requires for scoped packages.

**Error bodies.** One `fail` helper reads the body once, prefers the `message` of a JSON
`{code, message}` error, and otherwise collapses whitespace and caps the text at 500 characters.
Behind an ingress or proxy the body is often a full HTML page.

## Design (batch 2)

**Compact JSON.** Every tool built its own `{content: [{type, text}]}` envelope around
`JSON.stringify(value, null, 2)`. `textResult` in `src/tools/result.ts` is now the only place
that shape exists, and it drops the indentation: a tab with 59 nodes goes from 60,228 to 39,423
characters. Strings pass through untouched, so `get_node_help` uses the same helper for its
markdown instead of a local copy.

**Zod errors.** A `ZodError` stringifies to a pretty-printed JSON array, so one missing argument
reached the model as eleven lines. `formatZodError` in `src/errors.ts` renders a header naming
the tool and one `path: message` line per issue, with an empty path shown as `(root)`. A union
reports only "Invalid input" at the top level and keeps the real reasons in `unionErrors`, so
those are flattened in and de-duplicated, which is what makes `get_node_help`'s two argument
shapes readable. The `catch` in the call handler picks the format; other errors keep
`Error: <message>`.

**get_nodes grouping.** `GET /nodes` returns one entry per node set and repeats module, version,
local, user and enabled on each of the 48 entries a default install has. The tool groups them by
module in order of first appearance, keeps the module fields once, and maps each set name to its
de-duplicated types. A module is `enabled` only when all of its sets are; a partly disabled
module also lists `disabledSets`, while a fully disabled one needs nothing beyond the flag. The
grouping reads the response through a small local schema, because `NodeModuleSchema` describes a
different shape and only accepts these entries through `.passthrough()`. `client.getNodes()` is
unchanged, since `get_node_help` resolves types against the flat list.

## Design (batch 3)

**patch_flow.** `update_flow` replaces the flow with what is sent, so changing one property of
one node means echoing all 39,423 characters of a 59 node tab back, about 11,000 output tokens
for a one line change. `patch_flow` sends only the difference: `removeNodeIds`, `updateNodes`
(shallow merge by id, so an array such as `wires` is replaced whole), `addNodes`, `addConfigs`
and the tab's own `label`, `disabled` and `info`. It reads the flow with `FlowResponseSchema`,
applies remove, update and add in that order, and writes the merged flow back with
`PUT /flow/:id`; the merged result is validated before the write, for the same reason
`update_subflow` validates its merge. An unknown id on remove or update, a duplicate id on add
and a patch that requests no change are all errors, because each of them means the caller
believes something about the flow that is not true. Removals also rewrite the references the
removed nodes leave behind: ids disappear from every remaining `wires` array and from the
`nodes` list of remaining group nodes, and a `g` pointing at a removed group is dropped. Node-RED
accepts those dangling references and the editor then draws broken wires. The read and the write
are two requests, so an editor deploy between them is overwritten, which the tool description
says.

**get_flow selection.** Reading a tab to find one node cost the whole tab. `nodeIds` and `types`
keep a node or flow-scoped config node when either filter matches it, and add `totalNodes` and
`totalConfigs` so a filtered read cannot be mistaken for a small flow. `summary` reduces each
node to `id`, `type`, `name`, `g` and `wires`, dropping the coordinates and the per-node
configuration that are most of the characters, and each config node to `id`, `type` and `name`;
`wires` is omitted when it is missing or all ports are empty. A summary is not a valid input for
`update_flow`, which is why the description points at `patch_flow` instead. With none of the
three options the response is byte for byte what it was, straight from the client without a
parse, so an unusual flow cannot start failing on a schema.

**Object parameters.** The seven tools that took a flow, subflow or config node took it as a
JSON string, which costs about 16 percent in escaping and invites double-escaped output where a
single misplaced quote fails the call. Their arguments are now `z.union([z.record(z.unknown()),
z.string()])` and go through `parseJsonArgument`, which returns an object unchanged and parses a
string with the error text the tools used before, so clients that learned the old signature keep
working. `validate_flow` still answers `{valid: false, errors: [...]}` for a string it cannot
parse rather than failing the call, since an unparseable flow is exactly what it reports on.

## References

- [Node-RED Admin API: POST /flow](https://nodered.org/docs/api/admin/methods/post/flow/) - id is
  optional and generated when omitted
- [Node-RED Admin API: context](https://nodered.org/docs/api/admin/methods/get/context/) - scope,
  id and key path segments
- [undici Agent](https://undici.nodejs.org/#/docs/api/Agent) and
  [Dispatcher.RequestOptions](https://undici.nodejs.org/#/docs/api/Dispatcher) - `connectTimeout`,
  `headersTimeout`, `bodyTimeout`, `signal`
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) -
  `RequestHandlerExtra.signal` on request handlers
