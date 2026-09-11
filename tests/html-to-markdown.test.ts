import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToMarkdown } from '../src/html-to-markdown.js';

/**
 * Every word the reader would see in the browser has to survive the conversion, which is the one
 * property a lossy converter must not break. Punctuation and markers are left out of the
 * comparison because markdown adds its own.
 */
function visibleWords(html: string): string[] {
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return [...new Set(decodeEntities(text).match(/[\w.:/-]+/g) ?? [])];
}

function expectNoContentLoss(html: string, markdown: string): void {
  for (const word of visibleWords(html)) {
    expect(markdown).toContain(word);
  }
}

describe('decodeEntities', () => {
  it('should decode the named entities help uses', () => {
    expect(decodeEntities('a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos;&nbsp;e')).toBe(
      'a <b> & "c" \'d\' e'
    );
  });

  it('should decode numeric and hexadecimal entities', () => {
    expect(decodeEntities('&#039;&#39;&#x2192;&#8594;')).toBe("''→→");
  });

  it('should leave an unknown entity alone', () => {
    expect(decodeEntities('&frobnicate; &#0;')).toBe('&frobnicate; &#0;');
  });

  it('should decode an escaped entity once', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('htmlToMarkdown', () => {
  it('should convert a core node help block', () => {
    const html = `<p>Injects a message into a flow either manually or at regular intervals. The message
payload can be a variety of types, including strings, JavaScript objects or the current time.</p>
<h3>Outputs</h3>
<dl class="message-properties">
    <dt>payload<span class="property-type">various</span></dt>
    <dd>The configured payload of the message.</dd>
    <dt class="optional">topic <span class="property-type">string</span></dt>
    <dd>An optional property that can be configured in the node.</dd>
</dl>
<h3>Details</h3>
<p><b>Note</b>: The <i>"Interval between times"</i> option uses the standard cron system.</p>`;

    const markdown = htmlToMarkdown(html);

    expect(markdown).toBe(
      [
        'Injects a message into a flow either manually or at regular intervals. The message payload can be a variety of types, including strings, JavaScript objects or the current time.',
        '',
        '### Outputs',
        '',
        '- **payload** (various)',
        '  The configured payload of the message.',
        '- **topic** (string, optional)',
        '  An optional property that can be configured in the node.',
        '',
        '### Details',
        '',
        '**Note**: The *"Interval between times"* option uses the standard cron system.',
      ].join('\n')
    );
    expectNoContentLoss(html, markdown);
  });

  it('should convert a contrib node help block', () => {
    const html =
      '<p>This node allows you to send a request to Home Assistant (<code>light.turn_on</code>).</p><div class="home-assistant-custom-block tip"><p class="custom-block-title">Helpful Examples</p><p><a href="https://example.test/guide/action.html" rel="noopener noreferrer">Action Tips and Tricks</a></p></div><h3>Configuration</h3><dl class="message-properties"><dt>Action <span text="required" class="home-assistant-badge">required</span><span class="property-type">string</span></dt><ul><li>Accepts <a href="https://example.test/guide/mustache-templates.html" rel="noopener noreferrer">Mustache Templates</a></li></ul><dd>Action to perform</dd><dt>Data<span class="property-type">JSONata | JSON</span></dt><dd>JSON object to pass along.</dd></dl><h3>Input</h3><dl class="message-properties"><dd>Sample input</dd><pre><code class="language-JSON">{\n    "action": "homeassistant.turn_on"\n}\n</code></pre></dl>';

    const markdown = htmlToMarkdown(html);

    expect(markdown).toBe(
      [
        'This node allows you to send a request to Home Assistant (`light.turn_on`).',
        '',
        'Helpful Examples',
        '',
        '[Action Tips and Tricks](https://example.test/guide/action.html)',
        '',
        '### Configuration',
        '',
        '- **Action required** (string)',
        '  - Accepts [Mustache Templates](https://example.test/guide/mustache-templates.html)',
        '  Action to perform',
        '- **Data** (JSONata | JSON)',
        '  JSON object to pass along.',
        '',
        '### Input',
        '',
        '  Sample input',
        '',
        '```JSON',
        '{',
        '    "action": "homeassistant.turn_on"',
        '}',
        '```',
      ].join('\n')
    );
    expectNoContentLoss(html, markdown);
  });

  it('should render headings, paragraphs and line breaks', () => {
    const html = '<h1>Title</h1><h6>Deep</h6><p>One<br>Two</p><div>Three</div>';

    expect(htmlToMarkdown(html)).toBe(
      ['# Title', '', '###### Deep', '', 'One', 'Two', '', 'Three'].join('\n')
    );
  });

  it('should nest lists two spaces per level', () => {
    const html = '<ul><li>first</li><li>second<ol><li>inner</li><li>next</li></ol></li></ul>';

    expect(htmlToMarkdown(html)).toBe(
      ['- first', '- second', '  1. inner', '  2. next'].join('\n')
    );
  });

  it('should keep a fenced block verbatim without a language', () => {
    const html = '<p>Example</p><pre>  msg.payload = 1;\n  return msg;\n</pre>';

    expect(htmlToMarkdown(html)).toBe(
      ['Example', '', '```', '  msg.payload = 1;', '  return msg;', '```'].join('\n')
    );
  });

  it('should decode entities inside a fenced block without collapsing whitespace', () => {
    const html = '<pre><code>if (a &lt; b) {\n    return &quot;x&quot;;\n}</code></pre>';

    expect(htmlToMarkdown(html)).toBe(
      ['```', 'if (a < b) {', '    return "x";', '}', '```'].join('\n')
    );
  });

  it('should render a link, and just the href when there is no text', () => {
    const html =
      '<p>See <a href="https://example.test/a">the docs</a>, <a href="https://example.test/b"></a> and <a href="https://example.test/c">https://example.test/c</a>.</p>';

    expect(htmlToMarkdown(html)).toBe(
      'See [the docs](https://example.test/a), https://example.test/b and https://example.test/c.'
    );
  });

  it('should drop script and style with their content', () => {
    const html = '<p>Kept</p><script>var a = "gone";</script><style>.x { color: red }</style>';

    expect(htmlToMarkdown(html)).toBe('Kept');
  });

  it('should keep the content of a dropped tag', () => {
    const html = '<p><span class="home-assistant-badge">required</span> <small>note</small></p>';

    expect(htmlToMarkdown(html)).toBe('required note');
  });

  it('should collapse whitespace and trim the result', () => {
    const html = '\n\n<p>   a\n\n   b   </p>\n\n\n<p></p>\n<p>c</p>\n\n';

    expect(htmlToMarkdown(html)).toBe(['a b', '', 'c'].join('\n'));
  });

  it('should keep text that is not a tag', () => {
    expect(htmlToMarkdown('<p>5 < 6 and 7 &lt; 8</p>')).toBe('5 < 6 and 7 < 8');
  });

  it('should return an empty string for empty input', () => {
    expect(htmlToMarkdown('')).toBe('');
  });
});
