import { test } from 'node:test';
import assert from 'node:assert';
import {
  sanitizeHtml, cleanLinkUrl, linkFromInput, noteText, noteTitle, sortNotes,
  relativeTime, clockTime, plainTextToHtml,
} from '../apps/notes/notes-logic.js';

const A = (href) => `<a href="${href}" rel="noopener noreferrer" target="_blank">`;

// ---------- sanitizeHtml: allowlist ----------

test('sanitize keeps allowed formatting tags', () => {
  const html = '<p>a <b>b</b> <strong>s</strong> <i>i</i> <em>e</em> <u>u</u> <s>x</s> <code>c</code></p>'
    + '<h2>H</h2><h3>h</h3><ul><li>one</li></ul><ol><li>two</li></ol><blockquote>q</blockquote><pre>p  re</pre>';
  assert.strictEqual(sanitizeHtml(html), html);
});

test('sanitize turns div into p and keeps br', () => {
  assert.strictEqual(sanitizeHtml('<div>one</div><div><br></div><div>two<br/>three</div>'),
    '<p>one</p><p><br></p><p>two<br>three</p>');
});

test('sanitize maps h1 to h2 and h4-h6 to h3', () => {
  assert.strictEqual(sanitizeHtml('<h1>a</h1><h4>b</h4><H6>c</H6>'), '<h2>a</h2><h3>b</h3><h3>c</h3>');
});

test('sanitize drops unknown tags but keeps their text', () => {
  assert.strictEqual(sanitizeHtml('<span style="color:red">hi</span> <font face="x">there</font><o:p>!</o:p>'), 'hi there!');
  assert.strictEqual(sanitizeHtml('<html><head><meta charset="utf-8"></head><body><p>x</p></body></html>'), '<p>x</p>');
});

test('sanitize drops every attribute except href on a', () => {
  assert.strictEqual(sanitizeHtml('<p class="x" id="y" style="z" onclick="alert(1)">t</p>'), '<p>t</p>');
  assert.strictEqual(sanitizeHtml('<b onmouseover=alert(1)>t</b>'), '<b>t</b>');
  assert.strictEqual(sanitizeHtml('<a href="https://ex.com/?a=1&amp;b=2" title="t" onclick="x()" target="_self">l</a>'),
    `${A('https://ex.com/?a=1&amp;b=2')}l</a>`);
});

test('sanitize keeps http, https and mailto links, adds rel and target', () => {
  assert.strictEqual(sanitizeHtml('<a href="http://a.b">x</a>'), `${A('http://a.b')}x</a>`);
  assert.strictEqual(sanitizeHtml("<a href='HTTPS://a.b'>x</a>"), `${A('HTTPS://a.b')}x</a>`);
  assert.strictEqual(sanitizeHtml('<a href=mailto:me@x.y>x</a>'), `${A('mailto:me@x.y')}x</a>`);
  assert.strictEqual(sanitizeHtml('<a href="https://a.b/x>y">x</a>'), `${A('https://a.b/x&gt;y')}x</a>`, '> inside quotes');
});

// ---------- sanitizeHtml: XSS vectors ----------

const NO_ACTIVE = /<(?!\/?(p|br|b|strong|i|em|u|s|h2|h3|ul|ol|li|a|blockquote|code|pre)[\s>])|on\w+=|javascript:|data:|vbscript:/i;

const VECTORS = [
  '<img src=x onerror=alert(1)>',
  '<img src="x" onerror="alert(1)">',
  '<IMG SRC=JaVaScRiPt:alert(1)>',
  '<svg onload=alert(1)><circle/></svg>',
  '<svg><script>alert(1)</script></svg>',
  '<math><mtext><script>alert(1)</script></mtext></math>',
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<<script>script>alert(1)<</script>/script>',
  '<script>document.write("</scr"+"ipt><img src=x onerror=alert(1)>")</script>',
  '<style>@import "javascript:alert(1)";</style>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>">',
  '<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>',
  '<a href="java&#x09;script:alert(1)">x</a>',
  '<a href="java&Tab;script:alert(1)">x</a>',
  '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>',
  '<a href="&#x6A;avascript&colon;alert(1)">x</a>',
  '<a href="javascript&#58;alert(1)">x</a>',
  '<a href="&#0000106avascript:alert(1)">x</a>',
  '<a href="\u0001javascript:alert(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="//evil.example">x</a>',
  '<a href="https://ok.example" onclick="alert(1)">x</a>',
  '<a/href="javascript:alert(1)">x</a>',
  '<b/onmouseover=alert(1)>x</b>',
  '<p title="</p><img src=x onerror=alert(1)>">x</p>',
  '<!--<img src=x onerror=alert(1)>-->',
  '<!-- unclosed comment <img src=x onerror=alert(1)>',
  '<![CDATA[<img src=x onerror=alert(1)>]]>',
  '<b><i><img src=x onerror=alert(1)',
  '<details open ontoggle=alert(1)>',
  '<form action="javascript:alert(1)"><button>go</button></form>',
  '<input autofocus onfocus=alert(1)>',
  '<textarea><img src=x onerror=alert(1)></textarea>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  '<template><img src=x onerror=alert(1)></template>',
  '<base href="javascript:alert(1)//">',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<link rel="stylesheet" href="javascript:alert(1)">',
];

for (const vector of VECTORS) {
  test(`sanitize neutralises ${JSON.stringify(vector)}`, () => {
    const out = sanitizeHtml(vector);
    assert.ok(!NO_ACTIVE.test(out), `unsafe output: ${out}`);
    assert.strictEqual(sanitizeHtml(out), out, 'idempotent');
  });
}

test('sanitize drops script, style, iframe and comments with their contents', () => {
  assert.strictEqual(sanitizeHtml('a<script>alert(1)</script>b'), 'ab');
  assert.strictEqual(sanitizeHtml('a<style>p{color:red}</style>b'), 'ab');
  assert.strictEqual(sanitizeHtml('a<iframe src="https://x">inner</iframe>b'), 'ab');
  assert.strictEqual(sanitizeHtml('a<!-- secret -->b'), 'ab');
  assert.strictEqual(sanitizeHtml('a<svg><text>t</text></svg>b'), 'ab');
  assert.strictEqual(sanitizeHtml('a<script>never closed'), 'a');
});

test('sanitize drops links with unsafe href but keeps their text', () => {
  assert.strictEqual(sanitizeHtml('<a href="javascript:alert(1)">click</a>'), 'click');
  assert.strictEqual(sanitizeHtml('<a>bare</a>'), 'bare');
  assert.strictEqual(sanitizeHtml('<a href="/relative">rel</a>'), 'rel');
});

test('sanitize escapes stray text and keeps entities', () => {
  assert.strictEqual(sanitizeHtml('1 < 2 & 3 > 2 "q" \'s\''), '1 &lt; 2 &amp; 3 &gt; 2 &quot;q&quot; &#39;s&#39;');
  assert.strictEqual(sanitizeHtml('a &amp; b &lt;c&gt; &#65; &#x42; &nbsp;'), 'a &amp; b &lt;c&gt; A B  ');
  assert.strictEqual(sanitizeHtml('&mdash; &unknown;'), '— &amp;unknown;');
  assert.strictEqual(sanitizeHtml('a <3 b'), 'a &lt;3 b');
});

test('sanitize closes and balances tags', () => {
  assert.strictEqual(sanitizeHtml('<b>bold'), '<b>bold</b>');
  assert.strictEqual(sanitizeHtml('<b><i>x</b>y'), '<b><i>x</i></b>y');
  assert.strictEqual(sanitizeHtml('x</b></i>'), 'x');
  assert.strictEqual(sanitizeHtml('<ul><li>a<li>b</ul>'), '<ul><li>a</li><li>b</li></ul>');
  assert.strictEqual(sanitizeHtml('<p>a<p>b'), '<p>a</p><p>b</p>');
  assert.strictEqual(sanitizeHtml('<div><div>a</div>b</div>'), '<p>a</p>b');
  assert.strictEqual(sanitizeHtml('<a href="https://a.b">x<a href="https://c.d">y</a>'), `${A('https://a.b')}x</a>${A('https://c.d')}y</a>`);
});

test('sanitize handles empty and non-string input', () => {
  assert.strictEqual(sanitizeHtml(''), '');
  assert.strictEqual(sanitizeHtml(null), '');
  assert.strictEqual(sanitizeHtml(undefined), '');
  assert.strictEqual(sanitizeHtml(42), '42');
});

test('sanitize is idempotent on its own output', () => {
  const messy = '<div>x <span>y</span><b>z<i>w</div>&amp;<a href=" https://a.b?x=1&y=2 ">l</a>';
  const once = sanitizeHtml(messy);
  assert.strictEqual(sanitizeHtml(once), once);
});

// ---------- links ----------

test('cleanLinkUrl allows only http(s) and mailto, after decoding and stripping controls', () => {
  assert.strictEqual(cleanLinkUrl('https://a.b'), 'https://a.b');
  assert.strictEqual(cleanLinkUrl('  mailto:x@y.z '), 'mailto:x@y.z');
  assert.strictEqual(cleanLinkUrl('ht\ntp://a.b'), 'http://a.b');
  assert.strictEqual(cleanLinkUrl('javascript:alert(1)'), null);
  assert.strictEqual(cleanLinkUrl('java\tscript:alert(1)'), null);
  assert.strictEqual(cleanLinkUrl('ftp://a.b'), null);
  assert.strictEqual(cleanLinkUrl(''), null);
  assert.strictEqual(cleanLinkUrl('a.b'), null);
});

test('linkFromInput adds https:// to a bare host and rejects other schemes', () => {
  assert.deepStrictEqual(linkFromInput('example.com/x'), { ok: true, url: 'https://example.com/x' });
  assert.deepStrictEqual(linkFromInput('http://a.b'), { ok: true, url: 'http://a.b' });
  assert.deepStrictEqual(linkFromInput('mailto:me@x.y'), { ok: true, url: 'mailto:me@x.y' });
  assert.strictEqual(linkFromInput('javascript:alert(1)').ok, false);
  assert.strictEqual(linkFromInput('JavaScript:alert(1)').ok, false);
  assert.strictEqual(linkFromInput('   ').ok, false);
  assert.strictEqual(linkFromInput('data:text/html,x').ok, false);
});

// ---------- titles, text ----------

test('noteTitle is the first non-empty line of text, else Untitled', () => {
  assert.strictEqual(noteTitle('<h2>Shopping</h2><p>milk</p>'), 'Shopping');
  assert.strictEqual(noteTitle('First line<p>second</p>'), 'First line');
  assert.strictEqual(noteTitle('<p><br></p><p>  <b>Real</b> title </p>'), 'Real title');
  assert.strictEqual(noteTitle('a<br>b'), 'a');
  assert.strictEqual(noteTitle('<ul><li>item</li></ul>'), 'item');
  assert.strictEqual(noteTitle('Tom &amp; Jerry'), 'Tom & Jerry');
  assert.strictEqual(noteTitle(''), 'Untitled');
  assert.strictEqual(noteTitle('<p><br></p>'), 'Untitled');
  assert.strictEqual(noteTitle('<script>x</script>'), 'Untitled');
  assert.strictEqual(noteTitle('x'.repeat(200)).length, 80);
});

test('noteText flattens html to plain lines', () => {
  assert.strictEqual(noteText('<h2>A</h2><p>b <i>c</i></p>'), 'A\nb c');
  assert.strictEqual(noteText('<p><br></p>').trim(), '');
});

test('plainTextToHtml escapes and turns lines into paragraphs', () => {
  assert.strictEqual(plainTextToHtml('a <b>\nsecond'), '<p>a &lt;b&gt;</p><p>second</p>');
  assert.strictEqual(plainTextToHtml('one'), 'one');
  assert.strictEqual(plainTextToHtml('a\r\n\r\nb'), '<p>a</p><p><br></p><p>b</p>');
  assert.strictEqual(plainTextToHtml(''), '');
});

// ---------- lists, time ----------

test('sortNotes puts the most recently updated first without mutating', () => {
  const notes = [{ id: 'a', updatedAt: 1 }, { id: 'b', updatedAt: 3 }, { id: 'c', updatedAt: 2 }];
  assert.deepStrictEqual(sortNotes(notes).map(n => n.id), ['b', 'c', 'a']);
  assert.deepStrictEqual(notes.map(n => n.id), ['a', 'b', 'c']);
});

test('relativeTime reads like a quiet label', () => {
  const now = new Date(2026, 10, 8, 15, 0).getTime();
  assert.strictEqual(relativeTime(now - 10e3, now), 'Just now');
  assert.strictEqual(relativeTime(now - 5 * 60e3, now), '5m ago');
  assert.strictEqual(relativeTime(now - 3 * 3600e3, now), '3h ago');
  assert.strictEqual(relativeTime(new Date(2026, 10, 7, 9, 0).getTime(), now), 'Yesterday');
  assert.strictEqual(relativeTime(new Date(2026, 10, 4, 9, 0).getTime(), now), 'Wed');
  assert.strictEqual(relativeTime(new Date(2026, 2, 4, 9, 0).getTime(), now), 'Mar 4');
  assert.strictEqual(relativeTime(new Date(2024, 2, 4, 9, 0).getTime(), now), 'Mar 4, 2024');
  assert.strictEqual(relativeTime(now + 60e3, now), 'Just now', 'clock skew from another tab');
});

test('clockTime is HH:MM', () => {
  assert.strictEqual(clockTime(new Date(2026, 0, 1, 7, 5).getTime()), '07:05');
});
