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

export interface NodeArgument {
  /** Property name as the node stores it: "topic" for the field with id node-input-topic. */
  name: string;
  /** text, checkbox, select, textarea, hidden and so on. */
  inputType: string;
  /** Allowed values, for a select. */
  options?: string[];
  /** Only present when the markup carries literal text. Core nodes fill labels from i18n keys
   *  in the editor, so those come back without one. */
  label?: string;
  placeholder?: string;
  description?: string;
}

function scriptBlocks(configHtml: string, attribute: string): Map<string, string> {
  const pattern = new RegExp(
    `<script\\b[^>]*\\b${attribute}\\s*=\\s*(["'])(.*?)\\1[^>]*>([\\s\\S]*?)<\\/script\\s*>`,
    'gi'
  );
  const blocks = new Map<string, string>();
  for (const match of configHtml.matchAll(pattern)) {
    blocks.set(match[2].trim(), match[3]);
  }
  return blocks;
}

/**
 * Read the configurable properties out of a node's edit dialog.
 *
 * The dialog is a <script data-template-name> block whose fields carry ids of the form
 * node-input-<property>, or node-config-input-<property> for config nodes, because the editor
 * reads the values back through exactly those ids. Keying off the id follows that contract and
 * does not depend on how the markup around the field is nested.
 */
export function extractNodeArguments(configHtml: string): Map<string, NodeArgument[]> {
  const result = new Map<string, NodeArgument[]>();

  for (const [type, template] of scriptBlocks(configHtml, 'data-template-name')) {
    const labels = collectLabels(template);
    const args: NodeArgument[] = [];
    const seen = new Set<string>();

    const fieldPattern = /<(input|select|textarea)\b([^>]*)>/gi;
    for (const match of template.matchAll(fieldPattern)) {
      const tag = match[1].toLowerCase();
      const attributes = match[2];
      const id = attribute(attributes, 'id');
      if (!id) continue;

      const name = id.replace(/^node-(?:config-)?input-/, '');
      if (name === id || seen.has(name)) continue;
      seen.add(name);

      const label = labels.get(id);
      const placeholder = attribute(attributes, 'placeholder');
      const description = attribute(attributes, 'data-tooltip') ?? attribute(attributes, 'title');
      const options =
        tag === 'select' ? selectOptions(template.slice(match.index + match[0].length)) : undefined;

      args.push({
        name,
        // An <input> with no type attribute is a text field, per the HTML spec.
        inputType: attribute(attributes, 'type') ?? (tag === 'input' ? 'text' : tag),
        ...(options && options.length > 0 ? { options } : {}),
        ...(label ? { label } : {}),
        ...(placeholder ? { placeholder: decodeEntities(placeholder) } : {}),
        ...(description ? { description: decodeEntities(description) } : {}),
      });
    }

    result.set(type, args);
  }

  return result;
}

/**
 * Markup sometimes points several labels at one field: a group heading carrying fallback text
 * and the field's own label left empty for i18n. There is no way to tell which is meant, so a
 * contested id gets no label rather than a misleading one.
 */
function collectLabels(template: string): Map<string, string> {
  const labels = new Map<string, string>();
  const contested = new Set<string>();
  const pattern = /<label\b[^>]*\bfor\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/label\s*>/gi;

  for (const match of template.matchAll(pattern)) {
    const id = match[2];
    if (labels.has(id)) {
      contested.add(id);
      continue;
    }
    const text = htmlToText(match[3]);
    if (text) {
      labels.set(id, text);
    }
  }

  for (const id of contested) {
    labels.delete(id);
  }
  return labels;
}

/** Options are read from the markup after a <select>, up to its closing tag. Selects do not nest. */
function selectOptions(rest: string): string[] {
  const end = rest.search(/<\/select\s*>/i);
  const body = end === -1 ? rest : rest.slice(0, end);
  const options: string[] = [];
  for (const match of body.matchAll(/<option\b[^>]*\bvalue\s*=\s*(["'])(.*?)\1/gi)) {
    options.push(decodeEntities(match[2]));
  }
  return options;
}

function attribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match?.[2];
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  ).trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
