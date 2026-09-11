export interface NodeHelp {
  type: string;
  help: string;
}

/**
 * Pull the help sections out of a node set's config HTML.
 *
 * Node-RED appends the localised help file to the config, wrapped in
 * `<script type="text/html" data-help-name="<node type>">`. Content inside a `<script>`
 * element cannot contain the string `</script`, so matching up to the next closing tag is
 * exact here rather than an attempt at parsing HTML with a regex. Attribute order and quote
 * style vary between core nodes and contrib nodes, hence the loose tag match.
 */
export function extractNodeHelp(configHtml: string): NodeHelp[] {
  const helpBlock =
    /<script\b[^>]*\bdata-help-name\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/script\s*>/gi;

  const blocks: NodeHelp[] = [];
  for (const match of configHtml.matchAll(helpBlock)) {
    blocks.push({ type: match[2], help: match[3].trim() });
  }
  return blocks;
}
