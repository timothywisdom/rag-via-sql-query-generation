import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { looksLikeMarkdown } from "./markdown";

const markdownComponents: Components = {
  a: ({ href, children }) => {
    const safe = safeHref(href);
    if (!safe) return <span>{children}</span>;
    return (
      <a href={safe} rel="noreferrer noopener" target="_blank">
        {children}
      </a>
    );
  },
  img: ({ alt }) => <span>{alt}</span>,
};

export function AnswerText({ text }: { text: string }) {
  if (!looksLikeMarkdown(text)) return text;
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  if (href.startsWith("/") || href.startsWith("#")) return href;
  try {
    const url = new URL(href);
    if (url.protocol === "http:" || url.protocol === "https:") return href;
  } catch {
    return undefined;
  }
  return undefined;
}
