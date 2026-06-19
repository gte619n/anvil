import type { RenderedMarkdown } from "@protocol";

/**
 * Markdown → sanitized HTML seam (arch §8.3). The real pipeline (markdown-it + Shiki +
 * KaTeX + DOMPurify, impl plan 2) drops in behind this interface. For now a passthrough
 * that escapes HTML and preserves `source` so select-to-cite still has line truth.
 */
export interface MarkdownRenderer {
  render(source: string): RenderedMarkdown;
}

export class PassthroughRenderer implements MarkdownRenderer {
  render(source: string): RenderedMarkdown {
    return { source, html: `<pre class="md-raw">${escapeHtml(source)}</pre>` };
  }
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
