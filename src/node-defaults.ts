export interface NodeDefault {
  name: string;
  /** The value the editor starts a new node with. Undefined when the source is not a literal. */
  value?: unknown;
  /** Set when the property holds the id of a config node of this type. */
  type?: string;
  required?: boolean;
}

export interface NodeDefaults {
  properties: NodeDefault[];
  credentials: NodeDefault[];
}

type TokenKind = 'word' | 'string' | 'regex' | 'punct';

interface Token {
  kind: TokenKind;
  text: string;
}

const NUMBER = /^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*/;
const REGEX_AFTER_PUNCT = new Set('([{,;:=!&|?+-*/%^~<>'.split(''));
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * Split editor JavaScript into the tokens the object-literal reader needs. Strings, template
 * literals, comments and regular expressions are recognised only so that a brace or a comma
 * inside one cannot be mistaken for structure. Nothing here evaluates anything.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const end = stringEnd(source, index);
      tokens.push({ kind: 'string', text: source.slice(index, end) });
      index = end;
      continue;
    }
    if (char === '/' && regexAllowed(tokens)) {
      const end = regexEnd(source, index);
      tokens.push({ kind: 'regex', text: source.slice(index, end) });
      index = end;
      continue;
    }

    const rest = source.slice(index);
    const word = NUMBER.exec(rest) ?? IDENTIFIER.exec(rest);
    if (word) {
      tokens.push({ kind: 'word', text: word[0] });
      index += word[0].length;
      continue;
    }

    tokens.push({ kind: 'punct', text: char });
    index++;
  }

  return tokens;
}

/** A '/' opens a regular expression only where a value may start, otherwise it is division. */
function regexAllowed(tokens: Token[]): boolean {
  const previous = tokens[tokens.length - 1];
  if (!previous) return true;
  if (previous.kind === 'punct') return REGEX_AFTER_PUNCT.has(previous.text);
  return previous.kind === 'word' && REGEX_AFTER_WORD.has(previous.text);
}

function stringEnd(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;

  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      index = substitutionEnd(source, index + 2);
      continue;
    }
    index++;
  }
  return source.length;
}

/** A template substitution holds arbitrary code, including further strings and braces. */
function substitutionEnd(source: string, start: number): number {
  let depth = 1;
  let index = start;

  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') {
      index = stringEnd(source, index);
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return index + 1;
    index++;
  }
  return source.length;
}

function regexEnd(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;

  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    // A line break means the '/' was division after all; treat it as a lone character.
    if (char === '\n') return start + 1;
    if (inClass) {
      if (char === ']') inClass = false;
    } else if (char === '[') {
      inClass = true;
    } else if (char === '/') {
      index++;
      while (index < source.length && /[a-z]/i.test(source[index])) index++;
      return index;
    }
    index++;
  }
  return source.length;
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
};

function unescapeString(body: string): string {
  return body.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|[\s\S])/g,
    (_, sequence: string) => {
      if (sequence.startsWith('u{')) {
        return String.fromCodePoint(Number.parseInt(sequence.slice(2, -1), 16));
      }
      if (sequence.startsWith('u') || sequence.startsWith('x')) {
        return String.fromCharCode(Number.parseInt(sequence.slice(1), 16));
      }
      if (sequence === '\n' || sequence === '\r\n') return '';
      return ESCAPES[sequence] ?? sequence;
    }
  );
}

/** Undefined for a template literal with a substitution: its value is not known without running it. */
function stringValue(raw: string): string | undefined {
  const quote = raw[0];
  const body = raw.length > 1 && raw.endsWith(quote) ? raw.slice(1, -1) : raw.slice(1);
  if (quote === '`' && /(?:^|[^\\])\$\{/.test(body)) return undefined;
  return unescapeString(body);
}

const OPENING = new Set(['{', '[', '(']);
const CLOSING = new Set(['}', ']', ')']);

/**
 * Step over one value expression, ending at the comma or closing bracket that follows it. This is
 * what a value the reader does not understand costs: it is passed by, not interpreted.
 */
function skipValue(tokens: Token[], from: number): number {
  let depth = 0;
  let index = from;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token.kind === 'punct') {
      if (OPENING.has(token.text)) depth++;
      else if (CLOSING.has(token.text)) {
        if (depth === 0) return index;
        depth--;
      } else if (token.text === ',' && depth === 0) return index;
    }
    index++;
  }
  return index;
}

interface Parsed {
  value: unknown;
  next: number;
  literal: boolean;
}

const WORD_VALUES: Record<string, unknown> = {
  true: true,
  false: false,
  null: null,
  undefined: undefined,
};

function parseValue(tokens: Token[], from: number): Parsed {
  const token = tokens[from];
  if (!token) return { value: undefined, next: from, literal: false };

  if (token.kind === 'string') {
    const value = stringValue(token.text);
    return { value, next: from + 1, literal: value !== undefined };
  }
  if (token.kind === 'punct' && token.text === '{') return parseObject(tokens, from);
  if (token.kind === 'punct' && token.text === '[') return parseArray(tokens, from);
  if (token.kind === 'punct' && (token.text === '-' || token.text === '+')) {
    const next = tokens[from + 1];
    if (next?.kind === 'word' && NUMBER.test(next.text)) {
      const value = Number(next.text);
      const signed = token.text === '-' ? -value : value;
      return { value: signed, next: from + 2, literal: !Number.isNaN(value) };
    }
  }
  if (token.kind === 'word') {
    if (token.text in WORD_VALUES) {
      return { value: WORD_VALUES[token.text], next: from + 1, literal: true };
    }
    if (NUMBER.test(token.text)) {
      const value = Number(token.text);
      return { value, next: from + 1, literal: !Number.isNaN(value) };
    }
  }
  return { value: undefined, next: from, literal: false };
}

/** A literal has to end where its container says it does, so "a" + b is an expression, not a string. */
function ends(tokens: Token[], at: number): boolean {
  const token = tokens[at];
  return !token || (token.kind === 'punct' && (token.text === ',' || CLOSING.has(token.text)));
}

function readValue(tokens: Token[], from: number): Parsed {
  const parsed = parseValue(tokens, from);
  if (parsed.literal && ends(tokens, parsed.next)) return parsed;
  return { value: undefined, next: skipValue(tokens, from), literal: false };
}

function parseArray(tokens: Token[], from: number): Parsed {
  const value: unknown[] = [];
  let index = from + 1;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token.kind === 'punct' && token.text === ']') {
      return { value, next: index + 1, literal: true };
    }
    if (token.kind === 'punct' && token.text === ',') {
      index++;
      continue;
    }
    const element = readValue(tokens, index);
    value.push(element.value);
    index = element.next;
  }
  return { value, next: index, literal: true };
}

function parseObject(tokens: Token[], from: number): Parsed {
  const value: Record<string, unknown> = {};
  let index = from + 1;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token.kind === 'punct' && token.text === '}') {
      return { value, next: index + 1, literal: true };
    }
    if (token.kind === 'punct' && token.text === ',') {
      index++;
      continue;
    }

    const key = keyName(token);
    const colon = tokens[index + 1];
    if (key === undefined || colon?.kind !== 'punct' || colon.text !== ':') {
      // A shorthand property, a spread or a method: keep the object, lose the entry.
      index = skipValue(tokens, index);
      continue;
    }

    const parsed = readValue(tokens, index + 2);
    value[key] = parsed.value;
    index = parsed.next;
  }
  return { value, next: index, literal: true };
}

function keyName(token: Token): string | undefined {
  if (token.kind === 'word') return token.text;
  if (token.kind === 'string') return stringValue(token.text);
  return undefined;
}

/** Index of the first token of the value of `key`, searched at the top level of one object. */
function propertyValue(tokens: Token[], objectStart: number, key: string): number {
  let depth = 0;

  for (let index = objectStart; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === 'punct' && OPENING.has(token.text)) {
      depth++;
      continue;
    }
    if (token.kind === 'punct' && CLOSING.has(token.text)) {
      depth--;
      if (depth === 0) return -1;
      continue;
    }
    if (depth !== 1 || keyName(token) !== key) continue;
    const colon = tokens[index + 1];
    if (colon?.kind === 'punct' && colon.text === ':') return index + 2;
  }
  return -1;
}

const CALL = ['RED', '.', 'nodes', '.', 'registerType', '('];

function entries(tokens: Token[], optionsStart: number, key: string): NodeDefault[] | undefined {
  const at = propertyValue(tokens, optionsStart, key);
  const token = tokens[at];
  if (at === -1 || token?.kind !== 'punct' || token.text !== '{') return undefined;

  const parsed = parseObject(tokens, at).value as Record<string, unknown>;
  return Object.entries(parsed).map(([name, spec]) => {
    const entry: NodeDefault = { name };
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return entry;

    const record = spec as Record<string, unknown>;
    if ('value' in record) entry.value = record.value;
    if (typeof record.type === 'string') entry.type = record.type;
    if (typeof record.required === 'boolean') entry.required = record.required;
    return entry;
  });
}

function registerTypeCalls(source: string): Map<string, NodeDefaults> {
  const found = new Map<string, NodeDefaults>();
  if (!source.includes('registerType')) return found;

  const tokens = tokenize(source);
  for (let index = 0; index < tokens.length; index++) {
    if (!CALL.every((text, offset) => tokens[index + offset]?.text === text)) continue;

    const name = tokens[index + CALL.length];
    const comma = tokens[index + CALL.length + 1];
    const options = tokens[index + CALL.length + 2];
    if (name?.kind !== 'string' || comma?.text !== ',' || options?.text !== '{') continue;

    const type = stringValue(name.text);
    if (type === undefined) continue;

    const optionsStart = index + CALL.length + 2;
    const properties = entries(tokens, optionsStart, 'defaults');
    const credentials = entries(tokens, optionsStart, 'credentials');
    // A registration with neither is no answer at all, and the caller falls back to the dialog.
    if (!properties && !credentials) continue;

    found.set(type, { properties: properties ?? [], credentials: credentials ?? [] });
  }
  return found;
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const JAVASCRIPT = new Set(['text/javascript', 'application/javascript', 'text/module', 'module']);

/**
 * Read the properties a node stores out of its editor definition.
 *
 * The edit dialog only shows the fields that are written as markup; a node that builds its form
 * in `oneditprepare` hides most of what it saves. The `defaults` object passed to
 * `RED.nodes.registerType` is the authority, since Node-RED writes exactly those keys to the
 * flow, and it is in the same config HTML the dialog comes from. The object is read, never run.
 */
export function extractNodeDefaults(configHtml: string): Map<string, NodeDefaults> {
  const result = new Map<string, NodeDefaults>();

  for (const match of configHtml.matchAll(SCRIPT)) {
    const type = /\btype\s*=\s*(["'])(.*?)\1/i.exec(match[1])?.[2].trim().toLowerCase();
    if (type && !JAVASCRIPT.has(type)) continue;

    for (const [name, defaults] of registerTypeCalls(match[2])) {
      result.set(name, defaults);
    }
  }

  return result;
}
