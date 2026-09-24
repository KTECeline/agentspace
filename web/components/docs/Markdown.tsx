import Link from "next/link";
import type { ReactNode } from "react";
import type { Block, Inline } from "@/lib/docs/markdown";

/** Where a docs link goes: sibling docs ("costs", "costs.md#x") become /docs/costs(#x). */
function resolve(href: string): { href: string; external: boolean } {
  if (/^https?:\/\//.test(href)) return { href, external: true };
  if (/^(\/|#|mailto:)/.test(href)) return { href, external: false };
  const m = href.match(/^(?:\.\/)?([a-z0-9-]+)(?:\.md)?(#[\w-]*)?$/i);
  if (m) return { href: `/docs${m[1] === "index" ? "" : `/${m[1]}`}${m[2] ?? ""}`, external: false };
  return { href, external: false };
}

function inline(nodes: Inline[], key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case "text":
        return n.v;
      case "code":
        return (
          <code key={k} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em]">
            {n.v}
          </code>
        );
      case "strong":
        return <strong key={k}>{inline(n.c, k)}</strong>;
      case "em":
        return <em key={k}>{inline(n.c, k)}</em>;
      case "link": {
        const { href, external } = resolve(n.href);
        const cls = "text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent";
        return external ? (
          <a key={k} href={href} target="_blank" rel="noreferrer" className={cls}>
            {inline(n.c, k)}
          </a>
        ) : (
          <Link key={k} href={href} className={cls}>
            {inline(n.c, k)}
          </Link>
        );
      }
    }
  });
}

const H = { 1: "h1", 2: "h2", 3: "h3", 4: "h4" } as const;
const H_CLASS = {
  1: "font-display text-3xl font-semibold tracking-tight",
  2: "mt-10 scroll-mt-20 border-t border-border pt-6 font-display text-xl font-semibold",
  3: "mt-6 scroll-mt-20 font-display text-lg font-semibold",
  4: "mt-4 scroll-mt-20 font-semibold",
} as const;

export function Markdown({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "h": {
            const Tag = H[b.level];
            return (
              <Tag key={i} id={b.id} className={`group ${H_CLASS[b.level]}`}>
                {inline(b.c)}
                {b.level > 1 && (
                  <a href={`#${b.id}`} aria-label="Link to this section" className="ml-2 text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100">
                    #
                  </a>
                )}
              </Tag>
            );
          }
          case "p":
            return (
              <p key={i} className="mt-4 leading-7">
                {inline(b.c)}
              </p>
            );
          case "code":
            return (
              <pre key={i} className="mt-4 overflow-x-auto rounded-lg border border-border bg-surface-2 p-4 text-[13px] leading-6" data-lang={b.lang || undefined}>
                <code className="font-mono">{b.v}</code>
              </pre>
            );
          case "ul":
          case "ol": {
            const Tag = b.t;
            return (
              <Tag key={i} className={`mt-4 space-y-1.5 pl-6 leading-7 ${b.t === "ul" ? "list-disc" : "list-decimal"} marker:text-muted`}>
                {b.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </Tag>
            );
          }
          case "quote":
            return (
              <blockquote key={i} className="mt-4 rounded-r-lg border-l-4 border-accent bg-surface px-4 py-1 [&>p:first-child]:mt-2 [&>p:last-child]:mb-2">
                <Markdown blocks={b.c} />
              </blockquote>
            );
          case "table":
            return (
              <div key={i} className="mt-4 overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      {b.head.map((c, j) => (
                        <th key={j} className="py-2 pr-4 font-semibold" style={{ textAlign: b.align[j] ?? undefined }}>
                          {inline(c)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r} className="border-b border-border align-top">
                        {row.map((c, j) => (
                          <td key={j} className="py-2 pr-4 leading-6 [&>code]:whitespace-nowrap" style={{ textAlign: b.align[j] ?? undefined }}>
                            {inline(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "hr":
            return <hr key={i} className="my-8 border-border" />;
        }
      })}
    </>
  );
}
