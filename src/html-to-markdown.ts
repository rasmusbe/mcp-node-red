const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

/**
 * Node-RED help carries the entities HTML requires plus whatever the author typed, so the named
 * forms are limited to those six and anything numeric is decoded by code point. An entity that is
 * not recognised is left as it stands rather than guessed at.
 */
export function decodeEntities(value: string): string {
  return value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (entity, body: string) => {
    if (!body.startsWith('#')) {
      return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
    }
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    return Number.isNaN(code) || code < 1 || code > 0x10ffff ? entity : String.fromCodePoint(code);
  });
}

interface Tag {
  name: string;
  attributes: string;
  closing: boolean;
}

/** An attribute value may contain '>', so a tag ends at the first '>' outside quotes. */
function tagEnd(html: string, from: number): number {
  let quote = '';
  for (let i = from; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return -1;
}

function parseTag(source: string): Tag | undefined {
  const match = /^(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)([\s\S]*)$/.exec(source);
  if (!match) return undefined;
  return { closing: match[1] === '/', name: match[2].toLowerCase(), attributes: match[3] };
}

function attribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? decodeEntities(match[2]) : undefined;
}

function closingTag(html: string, name: string, from: number): { start: number; end: number } {
  const match = new RegExp(`</\\s*${name}\\s*>`, 'i').exec(html.slice(from));
  if (!match) return { start: html.length, end: html.length };
  return { start: from + match.index, end: from + match.index + match[0].length };
}

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const MARKERS: Record<string, string> = { b: '**', strong: '**', i: '*', em: '*', code: '`' };

/**
 * Inline runs are collected away from the line they belong to, because the markdown for a link,
 * an emphasis or a definition term can only be written once its closing tag has arrived. A sink
 * counts the tags of its own name that open inside it, so a plain span nested in a
 * property-type span does not close the sink early.
 */
interface Sink {
  tag: string;
  kind: 'link' | 'marker' | 'property-type' | 'term';
  text: string;
  marker?: string;
  href?: string;
  nesting: number;
}

/**
 * Turn a node's help block into markdown.
 *
 * Help is a fragment written by the node author rather than a document, so this is a scanner over
 * the tags help actually uses, not an HTML parser. A tag it does not know is dropped and its text
 * kept, which is the safe direction for a converter whose job is to cost fewer tokens without
 * losing what the author wrote. Nothing from the HTML is ever executed.
 */
export function htmlToMarkdown(html: string): string {
  const lines: string[] = [];
  const sinks: Sink[] = [];
  const lists: { ordered: boolean; index: number }[] = [];
  let line = '';
  let dlDepth = 0;
  let term: { type: string; optional: boolean } | undefined;

  const openSink = () => (sinks.length > 0 ? sinks[sinks.length - 1] : undefined);
  const currentText = () => openSink()?.text ?? line;

  function write(text: string): void {
    const sink = openSink();
    if (sink) sink.text += text;
    else line += text;
  }

  /** Runs of whitespace collapse to one space, and a space that would open a line is dropped. */
  function writeText(raw: string): void {
    const collapsed = raw.replace(/\s+/g, ' ');
    const before = currentText();
    const text =
      collapsed.startsWith(' ') && (before === '' || before.endsWith(' '))
        ? collapsed.slice(1)
        : collapsed;
    if (text) write(text);
  }

  /** A line with nothing on it is not a break: blank lines come from endBlock alone. */
  function breakLine(): void {
    if (sinks.length > 0) {
      writeText(' ');
      return;
    }
    if (line.trim() !== '') lines.push(line.trimEnd());
    line = '';
  }

  function endBlock(): void {
    breakLine();
    if (sinks.length === 0) lines.push('');
  }

  /** The markers have to hug the text, so the spacing around the tag is written separately. */
  function writeWrapped(text: string, marker: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      writeText(text);
      return;
    }
    if (/^\s/.test(text)) writeText(' ');
    write(marker + trimmed + marker);
    if (/\s$/.test(text)) writeText(' ');
  }

  function writeLink(text: string, href: string | undefined): void {
    if (!href) {
      writeText(text);
      return;
    }
    const label = text.trim();
    if (/^\s/.test(text)) writeText(' ');
    write(label === '' || label === href ? href : `[${label}](${href})`);
    if (/\s$/.test(text)) writeText(' ');
  }

  function writeTerm(name: string): void {
    const detail = [term?.type, term?.optional ? 'optional' : ''].filter(Boolean).join(', ');
    write('  '.repeat(Math.max(0, dlDepth - 1)));
    write('-');
    if (name) write(` **${name}**`);
    if (detail) write(` (${detail})`);
    breakLine();
    term = undefined;
  }

  function finishSink(sink: Sink): void {
    if (sink.kind === 'link') writeLink(sink.text, sink.href);
    else if (sink.kind === 'marker') writeWrapped(sink.text, sink.marker ?? '');
    else if (sink.kind === 'term') writeTerm(sink.text.trim());
    else if (term) term.type = sink.text.trim();
    else writeText(sink.text);
  }

  /** A fenced block keeps its own line breaks, so it enters the output as one entry. */
  function writeFence(inner: string): void {
    const code = /<code\b([^>]*)>/i.exec(inner);
    const language = /\blanguage-([\w+#.-]+)/i.exec(
      code ? (attribute(code[1], 'class') ?? '') : ''
    );
    const body = decodeEntities(inner.replace(/<[^>]*>/g, ''))
      .replace(/^[ \t\r]*\n/, '')
      .replace(/\s+$/, '');
    const fence = '```';
    endBlock();
    lines.push([fence + (language?.[1] ?? ''), body, fence].join('\n'), '');
  }

  const listIndent = () => '  '.repeat(dlDepth + Math.max(0, lists.length - 1));

  function openTag(tag: Tag): void {
    const sink = openSink();
    if (sink && sink.tag === tag.name) {
      sink.nesting++;
      return;
    }

    switch (tag.name) {
      case 'br':
        breakLine();
        return;
      case 'a':
        sinks.push({
          tag: 'a',
          kind: 'link',
          text: '',
          href: attribute(tag.attributes, 'href'),
          nesting: 0,
        });
        return;
      case 'b':
      case 'strong':
      case 'i':
      case 'em':
      case 'code':
        sinks.push({
          tag: tag.name,
          kind: 'marker',
          marker: MARKERS[tag.name],
          text: '',
          nesting: 0,
        });
        return;
      case 'span':
        if (/\bproperty-type\b/.test(attribute(tag.attributes, 'class') ?? '')) {
          sinks.push({ tag: 'span', kind: 'property-type', text: '', nesting: 0 });
        }
        return;
      case 'p':
      case 'div':
        endBlock();
        return;
      case 'dl':
        endBlock();
        dlDepth++;
        return;
      case 'dt':
        breakLine();
        term = {
          type: '',
          optional: /\boptional\b/.test(attribute(tag.attributes, 'class') ?? ''),
        };
        sinks.push({ tag: 'dt', kind: 'term', text: '', nesting: 0 });
        return;
      case 'dd':
        breakLine();
        write('  '.repeat(dlDepth));
        return;
      case 'ul':
      case 'ol':
        if (lists.length === 0 && dlDepth === 0) endBlock();
        else breakLine();
        lists.push({ ordered: tag.name === 'ol', index: 1 });
        return;
      case 'li': {
        breakLine();
        const list = lists[lists.length - 1];
        write(listIndent() + (list?.ordered ? `${list.index++}. ` : '- '));
        return;
      }
      default:
        if (HEADINGS.has(tag.name)) {
          endBlock();
          write(`${'#'.repeat(Number(tag.name[1]))} `);
        }
    }
  }

  function closeTag(tag: Tag): void {
    const sink = openSink();
    if (sink && sink.tag === tag.name) {
      if (sink.nesting > 0) sink.nesting--;
      else finishSink(sinks.pop() as Sink);
      return;
    }

    switch (tag.name) {
      case 'p':
      case 'div':
        endBlock();
        return;
      case 'dl':
        dlDepth = Math.max(0, dlDepth - 1);
        endBlock();
        return;
      case 'dd':
      case 'li':
        breakLine();
        return;
      case 'ul':
      case 'ol':
        lists.pop();
        if (lists.length === 0 && dlDepth === 0) endBlock();
        else breakLine();
        return;
      default:
        if (HEADINGS.has(tag.name)) endBlock();
    }
  }

  let index = 0;
  while (index < html.length) {
    const start = html.indexOf('<', index);
    if (start === -1) {
      writeText(decodeEntities(html.slice(index)));
      break;
    }
    if (start > index) writeText(decodeEntities(html.slice(index, start)));

    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }

    const end = tagEnd(html, start + 1);
    const tag = end === -1 ? undefined : parseTag(html.slice(start + 1, end));
    if (!tag) {
      // A '<' that opens nothing is text the author wrote.
      writeText('<');
      index = start + 1;
      continue;
    }
    index = end + 1;

    if (tag.name === 'script' || tag.name === 'style') {
      index = tag.closing ? index : closingTag(html, tag.name, index).end;
      continue;
    }
    if (tag.name === 'pre' && !tag.closing) {
      const close = closingTag(html, 'pre', index);
      writeFence(html.slice(index, close.start));
      index = close.end;
      continue;
    }

    if (tag.closing) closeTag(tag);
    else openTag(tag);
  }
  breakLine();

  const output: string[] = [];
  for (const entry of lines) {
    if (entry === '' && (output.length === 0 || output[output.length - 1] === '')) continue;
    output.push(entry);
  }
  return output.join('\n').trim();
}
