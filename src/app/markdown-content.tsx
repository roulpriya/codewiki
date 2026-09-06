import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Raw HTML stays disabled and URL protocols are checked by react-markdown. */
export function MarkdownContent({ markdown }: { markdown: string }) {
  return <div className="prose"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    // Repository-authored remote images must not track readers or trigger network requests.
    img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    table: ({ children }) => <div className="prose-table-scroll"><table>{children}</table></div>,
  }}>{markdown}</Markdown></div>;
}
