import { test } from 'node:test';
import assert from 'node:assert';
import { parseBookmarkHtml, mergeImported, groupBookmarks, faviconUrl, shortcutKey } from '../apps/bookmarks/bookmarks-logic.js';

// Shape of a Chrome / Firefox / Safari export (Netscape bookmark file).
const EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://news.ycombinator.com/" ADD_DATE="1">Hacker News</A>
        <DT><H3 ADD_DATE="1">Dev &amp; Docs</H3>
        <DL><p>
            <DT><A HREF="https://developer.mozilla.org/en-US/" ICON="data:image/png;base64,AAA">MDN &lt;Web&gt; Docs</A>
            <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
        </DL><p>
        <DT><A HREF="https://example.com/a?x=1&amp;y=2">Example</A>
    </DL><p>
    <DT><H3>Reading</H3>
    <DL><p>
        <DT><A HREF="http://blog.example.org">Blog</A>
    </DL><p>
</DL><p>`;

test('parseBookmarkHtml reads links, innermost folder as group, skips non-http', () => {
  const items = parseBookmarkHtml(EXPORT);
  assert.deepStrictEqual(items, [
    { title: 'Hacker News', url: 'https://news.ycombinator.com/', group: '' },
    { title: 'MDN <Web> Docs', url: 'https://developer.mozilla.org/en-US/', group: 'Dev & Docs' },
    { title: 'Example', url: 'https://example.com/a?x=1&y=2', group: '' },
    { title: 'Blog', url: 'http://blog.example.org', group: 'Reading' },
  ]);
});

test('parseBookmarkHtml returns nothing for unrelated text', () => {
  assert.deepStrictEqual(parseBookmarkHtml('hello'), []);
  assert.deepStrictEqual(parseBookmarkHtml(''), []);
});

test('parseBookmarkHtml uses the URL when a link has no title', () => {
  assert.deepStrictEqual(parseBookmarkHtml('<DT><A HREF="https://x.dev"></A>'), [{ title: 'https://x.dev', url: 'https://x.dev', group: '' }]);
});

test('mergeImported appends new links and skips ones already saved', () => {
  let n = 0;
  const existing = [{ id: 'b1', title: 'HN', url: 'https://news.ycombinator.com/' }];
  const { list, added, skipped } = mergeImported(existing, parseBookmarkHtml(EXPORT), () => `n${++n}`);
  assert.strictEqual(added, 3);
  assert.strictEqual(skipped, 1);
  assert.strictEqual(list[0].id, 'b1', 'existing order kept');
  assert.deepStrictEqual(list.slice(1).map(b => b.id), ['n1', 'n2', 'n3']);
  assert.strictEqual(list[1].group, 'Dev & Docs');
});

test('mergeImported treats trailing slash and case of host as the same link', () => {
  const existing = [{ id: 'b1', title: 'A', url: 'https://Example.com' }];
  const { added } = mergeImported(existing, [{ title: 'A', url: 'https://example.com/', group: '' }], () => 'x');
  assert.strictEqual(added, 0);
});

test('groupBookmarks: ungrouped first, then groups in first-seen order', () => {
  const groups = groupBookmarks([
    { id: '1', group: 'Work' },
    { id: '2' },
    { id: '3', group: 'Fun' },
    { id: '4', group: 'Work' },
    { id: '5', group: '  ' },
  ]);
  assert.deepStrictEqual(groups.map(g => [g.name, g.items.map(i => i.id).join('')]), [
    ['', '25'],
    ['Work', '14'],
    ['Fun', '3'],
  ]);
});

test('faviconUrl points at the site root favicon, only for http(s)', () => {
  assert.strictEqual(faviconUrl('https://www.example.com/path?q=1'), 'https://www.example.com/favicon.ico');
  assert.strictEqual(faviconUrl('javascript:alert(1)'), null);
  assert.strictEqual(faviconUrl('not a url'), null);
});

test('shortcutKey maps plain digit keys 1-9 to an index', () => {
  assert.strictEqual(shortcutKey({ key: '1' }), 0);
  assert.strictEqual(shortcutKey({ key: '9' }), 8);
  assert.strictEqual(shortcutKey({ key: '0' }), -1);
  assert.strictEqual(shortcutKey({ key: '1', metaKey: true }), -1, 'Cmd+1 is the browser tab switch');
  assert.strictEqual(shortcutKey({ key: '1', ctrlKey: true }), -1);
  assert.strictEqual(shortcutKey({ key: '1', altKey: true }), -1);
  assert.strictEqual(shortcutKey({ key: 'a' }), -1);
});
