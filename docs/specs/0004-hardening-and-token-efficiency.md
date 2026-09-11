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

- [x] `NodeSetSchema` that matches `GET /nodes`; remove the duplicate parse in `get_node_help`
- [x] Node set cache in the client, invalidated by `install_node`, `remove_node_module`,
      `set_node_module_state`
- [x] Lightweight schema for `list_flows`
- [x] Parallel fetches in `delete_subflow` and `delete_global_config_node`
- [x] One retry on `ECONNREFUSED`/`ECONNRESET` for GET requests
- [x] `validate_flow` checks wires, `z` and installed node types

### Batch 5, get_node_help

- [x] Help HTML rendered as markdown
- [x] Configurable properties read from the node's `defaults` in `RED.nodes.registerType`

### Batch 6, optimistic locking

Decided 2026-09-11: global flow writes move to `POST /flows` with `rev`, so a concurrent editor
deploy answers 409 instead of being overwritten. Hiding `get_flow_state` and `set_flow_state`
when `runtimeState` is disabled was considered and declined: it saves about 700 characters per
session and makes startup depend on Node-RED answering.

- [x] Optimistic locking with `rev` for global flow writes (subflow and global config node tools)

### Batch 7, tool list size

- [x] Tool descriptions shortened; serialized list under 9,000 characters, guarded by a test

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

## Design (batch 4)

**Node set schema.** `GET /nodes` answers with a flat array of node sets, each
`{id: "node-red/inject", name, types, enabled, module, version, local, user}`, but
`client.getNodes` parsed it with `NodeModuleSchema`, which describes a module and only accepted
these entries because it passes unknown keys through. `NodeSetSchema` already had the right
shape, so `getNodes` returns `NodeSet[]` and the two local copies of the schema, one in
`get_nodes` and one in `get_node_help`, are gone. `NodeModuleSchema` stays where the response
really is a module object: `install_node` and `set_node_module_state`.

**Node set cache.** Resolving a node type in `get_node_help` fetched the whole node list every
time. `getNodes({cached: true})` answers from a list younger than `NODE_SET_CACHE_TTL_MS`, five
minutes, and otherwise fetches; the plain `getNodes()` that `get_nodes` uses always fetches and
refreshes what is held, so the tool still shows the current state. Concurrent callers share the
one request in flight, and a failed fetch is not left behind as that request. `install_node`,
`remove_node_module` and `set_node_module_state` clear the cache, and `resolveType` asks once
more without the cache before reporting a type as unknown, which covers a module installed from
the editor while the cache is warm. The cache lives in a holder object because `withSignal`
copies own properties into its view, so a field that gets reassigned would only ever update one
of the two. The HTTP transport built a client per request through `createServer`, which left the
cache no life at all, so `createServer` now takes an optional client, `createClient` is exported
for the callers that need one, and `createStreamableHttpRequestHandler` builds a single client
and a single handler that every request shares.

**Lightweight list_flows.** `list_flows` needs the tabs, and `getFlows` parses the whole
`/flows` payload, 500 KB and about 780 items on the measured instance, through a three-way union
of passthrough objects: 9 to 11 ms of Zod against 1.3 ms of `JSON.parse`. `client.listTabs` reads
the same response with a schema that declares four fields and strips the rest, so Zod never walks
a node's properties, and returns only the tabs. The output is `{id, label}` per tab plus
`disabled` when the tab is disabled; `type` is gone, because every item in the list is a tab.
`getFlows` stays for the tools that need every node.

**Parallel fetches.** `delete_subflow` and `delete_global_config_node` need the global flow and
the flow list, and neither read depends on the other, so they go out together. The checks keep
their order: not found is still reported before the instance or reference check.

**One retry for connection failures.** Node-RED restarts after `install_node` and whenever the
Home Assistant add-on updates, and the first request into that window fails with `ECONNREFUSED`
or `ECONNRESET` before it reaches the server. Every request now goes through one `send` method,
which retries a GET once after `RETRY_DELAY_MS`, 500 ms, when the error code, or the code on its
cause, is one of `ECONNREFUSED`, `ECONNRESET`, `UND_ERR_SOCKET` or `EPIPE`. Nothing else is
retried: a write could be repeated after Node-RED already applied it, an aborted call is meant to
stop, and a timeout means the server may still be working on the first attempt.

**validate_flow.** The old check lived in the client and only looked for missing ids and types,
which is close to nothing: Node-RED accepts a node whose type is not installed and deploys it as
an `unknown` node, and accepts a wire to an id that does not exist. The logic moved into the tool
and now reports duplicate ids and a node that reuses the flow id, a wire to an id that is not in
the flow, a `z` that names another flow, a `g` that is not a group in the flow and a group that
lists a node that is not there, and any type that no installed node set registers. A type is
known when a node set registers it, when it is `group`, which the editor draws and no module
provides, or when it is `subflow:<id>` for a subflow in the global flow. The node sets are read
from the cache and refetched once before a type is reported as missing, for the same reason
`get_node_help` does. The flow id is optional here, because a `create_flow` payload has none yet,
and the `z` check is skipped when there is no id to compare against.

## Design (batch 5)

**Help as markdown.** The help block was passed through as raw HTML: `api-call-service` from
node-red-contrib-home-assistant-websocket is about 6,600 characters, a third of it tags and the
`rel="noopener noreferrer"` that repeats on every link, and the same link appears seven times.
`htmlToMarkdown` in `src/html-to-markdown.ts` is a scanner over the tags help actually uses, not
an HTML parser, because help is a fragment written by the node author rather than a document:
headings, paragraphs, lists, `dl` message properties, `pre` fences with the language from a
`language-xxx` class, links, emphasis and code. A tag it does not know is dropped and its text
kept, `script` and `style` go with their content, and nothing from the HTML is ever executed. An
inline run is collected in a sink until its closing tag arrives, since the markdown for a link or
a definition term can only be written once its text is complete; a sink counts the tags of its own
name that open inside it, so a plain span nested in a `property-type` span does not close it
early. Node-RED also accepts help written in markdown, in a
`<script type="text/markdown" data-help-name>`; `extractNodeHelp` reports the script's `type` as
`format` and such a block passes through with only trimming. `decodeEntities` moved into the new
module, extended with the numeric `&#NNN;` and `&#xHH;` forms, so there is one copy.

**Properties from `defaults`.** The property list came from the `<input>` and `<select>` ids in
the edit dialog, which only sees the fields written as markup: for `api-call-service` that is 10
properties against the roughly 20 the node stores, missing `action`, `floorId`, `areaId`,
`deviceId`, `entityId`, `labelId`, `outputProperties`, `domain` and `service` because the editor
renders them from JavaScript, and reporting `server` as `text` when it holds a config node id.
The authority is the `defaults` object passed to `RED.nodes.registerType`, which Node-RED writes
to the flow key for key, and it sits in the same config HTML. `extractNodeDefaults` in
`src/node-defaults.ts` tokenizes the editor JavaScript, finds each `registerType` call, and reads
the `defaults` and `credentials` objects with a recursive-descent parser for the object-literal
subset: strings, numbers, booleans, `null`, `undefined`, arrays, nested objects, trailing commas
and comments. Strings, template literals, comments and regular expressions are recognised only so
that a brace or a comma inside one cannot be mistaken for structure. A value that is not a literal
(`RED.validators.number()`, a function, `RED._("...")`, a template literal with a substitution) is
stepped over as one balanced expression and yields `undefined`. Nothing is evaluated: there is no
`vm`, no `eval`, no `new Function`. The tool then renders one line per property of `defaults`, in
that order, with `config node "<type>"` where a type is declared, the dialog's input type, options,
label, placeholder and description merged in by field id, and the default as JSON cut at 80
characters. A dialog field that is not in `defaults` is dropped, because Node-RED does not save
it; a registration with neither `defaults` nor `credentials` is no answer at all and the dialog
list is used as before.

## Design (batch 6)

**What the Node-RED source says.** `editor-api/lib/admin/flows.js` reads the API version from
`Node-RED-API-Version` (default v1, must match `/^v[12]$/`) and the deploy mode from
`Node-RED-Deployment-Type` (default `full`); for v2 and any mode but `reload` it passes the
request body through untouched, so the body is `{rev, flows}`, and it answers the runtime result
with `res.json(result)`, which is 200 with `{rev}`. v1 answers 204 and takes a bare array instead.
`runtime/lib/api/flows.js` `setFlows` runs under a mutex, and when the body has a `rev` it
compares it against `runtime.flows.getFlows().rev` and throws an error with `code:
"version_mismatch"` and `status: 409`; the error is built with `new Error()` and no message, so
`rejectHandler` in `editor-api/lib/util.js` falls back to `err.toString()` and the 409 body reads
`{"code":"version_mismatch","message":"Error"}`. The four deploy modes are `full`, `nodes`,
`flows` and `reload`; `reload` is handled in the API layer and discards the body, the other three
reach `runtime/lib/flows/index.js` `setFlows`, where `full` restarts everything and the others
restart against the computed diff.

**Credentials survive the round trip.** `runtime/lib/flows/index.js` calls
`credentials.clean(config)` when a deploy carries no credentials object, and `clean` in
`runtime/lib/nodes/credentials.js` only drops cached credentials for ids that are *not* in the
posted configuration, extracting the credentials of nodes that do carry them. So posting back the
nodes read from `GET /flows`, which never includes credentials, keeps every stored credential as
long as the node id is still in the list. That is what makes a whole-configuration write safe
here.

**The flat model.** `GET /flows` is one flat array: tabs (`type: "tab"`), subflow definitions
(`type: "subflow"`, without nested `nodes`/`configs`), every node with a `z` naming its tab or
subflow, and global config nodes with no `z` at all. `GET /flow/global` is the nested view of the
same data and stays the read side of `get_subflows` and `validate_flow`; the six writing tools now
work on the flat list, because that is what `POST /flows` takes. Splitting a subflow's contents
back into `nodes` and `configs` follows Node-RED's own rule from `parseConfig` in
`runtime/lib/flows/util.js`: an item with both `x` and `y` is a node, anything else is a config
node. A global config node is an item with no `z` that is not itself a tab or a subflow
definition.

**One write path.** `modifyFlows` in `src/tools/global-flow.ts` reads `GET /flows`, hands the
list to a `mutate` callback and posts the result with the rev it read. A 409 comes back as
`FlowsConflictError` from the client, and the helper re-reads and re-applies once, which is why
`mutate` has to be a pure function of the list it is given; a second conflict is reported rather
than forced, and an error thrown by `mutate` itself (not found, already exists, still referenced)
is passed through and not retried. The deployment type is `nodes`, the editor's own default, so
only the nodes that actually changed restart.

**What it costs.** The whole configuration goes over the wire on every write, about 500 KB on the
measured instance, against the previous `PUT /flow/global` which sent only the global scope. That
is the price of the lock, and it was accepted.

**Key order is preserved on the way through.** Zod's `.passthrough()` emits the keys a schema
declares before the rest, so a parsed copy of a node has its `wires` ahead of its `x` and `y`.
Writing parsed copies back would have rewritten the key order of every item in flows.json on
every call, which is nothing to Node-RED but a whole-file diff for anyone keeping flows.json in
git. Every path that reads JSON and writes it back now validates with the schema and passes on
the object it was given: `client.getFlows`, which `modifyFlows` writes back in full; the read and
the merged body in `patch_flow`, where the schema's `nodes`/`configs` defaults no longer stand in
and the two lists are read with `?? []`; the definition and the replacement lists in
`update_subflow`; and the objects `update_flow` and `update_global_config_node` are handed. The
tools still write parsed copies where the item is new (`create_flow`, `create_subflow`,
`create_global_config_node`), since there is no stored order to keep. `listTabs` parses a
stripping schema, and nothing writes its result back.

## Design (batch 7)

**Tool list size.** The serialized tool list goes to the model at the start of every session, and
the tools added since batch 3 had grown it from 9,879 to 13,183 characters. Each description is
now one sentence, restatements of the HTTP endpoint and "from Node-RED" filler are gone, and a
parameter whose name and type already say everything carries no description. The behavioural facts
stay: which tool to prefer, what is not valid input, what a filter matches, what an operation
refuses. The optimistic locking sentence that was repeated on six tools is now one clause on
`create_subflow` and one on `create_global_config_node`, scoped to the whole family, and the
"a JSON string is also accepted" note is gone from all seven object parameters, since the schema
says `object` and the string tolerance is only there for older clients. The total is 8,676
characters, and `tests/server.test.ts` fails if it passes 9,500.

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
- [`@node-red/editor-api/lib/admin/flows.js`](https://github.com/node-red/node-red/blob/master/packages/node_modules/%40node-red/editor-api/lib/admin/flows.js) -
  API version and deployment type headers, v2 request and response shapes
- [`@node-red/runtime/lib/api/flows.js`](https://github.com/node-red/node-red/blob/master/packages/node_modules/%40node-red/runtime/lib/api/flows.js) -
  the `rev` comparison and the 409 `version_mismatch`
- [`@node-red/runtime/lib/flows/util.js`](https://github.com/node-red/node-red/blob/master/packages/node_modules/%40node-red/runtime/lib/flows/util.js) -
  `parseConfig`, which splits a container's items into nodes and configs on `x`/`y`
- [`@node-red/runtime/lib/nodes/credentials.js`](https://github.com/node-red/node-red/blob/master/packages/node_modules/%40node-red/runtime/lib/nodes/credentials.js) -
  `clean`, which keeps the credentials of every node still present in the posted configuration
