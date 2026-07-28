import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DomainFavicon } from "./domain-favicon";
import { safeExternalUrl } from "../lib/snapshot-evidence";

function domainFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function MarkdownLink({
  href,
  children,
}: ComponentPropsWithoutRef<"a">) {
  const safeHref = safeExternalUrl(href);
  if (!safeHref) return <span>{children}</span>;

  return (
    <a
      className="answer-citation-link"
      href={safeHref}
      target="_blank"
      rel="noreferrer"
    >
      <DomainFavicon domain={domainFromUrl(safeHref)} size={13} />
      {children}
    </a>
  );
}

function MarkdownImage({
  src,
  alt,
}: ComponentPropsWithoutRef<"img">) {
  const safeSrc = safeExternalUrl(src);
  if (!safeSrc) return alt ? <span>{alt}</span> : null;

  return <img src={safeSrc} alt={alt ?? ""} loading="lazy" />;
}

export function MarkdownAnswer({ markdown }: { markdown: string }) {
  return (
    <div className="answer-copy">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: MarkdownLink,
          img: MarkdownImage,
          table: ({ children }) => (
            <div className="answer-table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
