/**
 * [Phase 4 / SEC-L6] linkifyUrls — escapes text and turns bare URLs into new-tab links with
 * rel="noopener noreferrer" (reverse-tabnabbing defense). Pure string logic, no DOM.
 */
import { test, expect } from "bun:test";
import { esc, linkifyUrls } from "../../web/src/dom";

test("esc escapes the HTML-significant characters, quotes included", () => {
  expect(esc('<b>&"</b>')).toBe("&lt;b&gt;&amp;&quot;&lt;/b&gt;");
  expect(esc("it's")).toBe("it&#39;s");
});

// This is the reason quotes are in the set. `esc` is used as `value="${esc(x)}"` all over main.ts,
// so escaping only `& < >` left every attribute site breakable — CodeQL's
// js/incomplete-html-attribute-sanitization. The earlier version of the test above asserted the
// quote passed through unescaped, which pinned the gap rather than a decision.
test("esc output cannot break out of a quoted attribute", () => {
  const hostile = 'a" onerror="alert(1)';
  const html = `<img alt="${esc(hostile)}">`;
  expect(html).toBe('<img alt="a&quot; onerror=&quot;alert(1)">');
  expect(html).not.toContain('" onerror'); // no second attribute was smuggled in
});

test("linkifyUrls turns a URL into a safe new-tab link", () => {
  const html = linkifyUrls("see https://example.com/x for more");
  expect(html).toContain('href="https://example.com/x"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"'); // the L6 fix
});

test("linkifyUrls escapes surrounding text so it can't inject tags", () => {
  const html = linkifyUrls("<script>alert(1)</script> https://ok.test");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
});

test("linkifyUrls handles multiple URLs and plain text without links", () => {
  const html = linkifyUrls("a https://one.test b https://two.test");
  expect(html.match(/<a /g)?.length).toBe(2);
  expect(linkifyUrls("no links here")).toBe("no links here");
});
