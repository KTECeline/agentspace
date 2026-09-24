import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/docs/Markdown";
import { parseMarkdown, titleOf } from "@/lib/docs/markdown";
import { DOCS_NAV, DOCS_PAGES } from "@/lib/docs/nav";

// Every page is rendered at build time from web/content/docs; unknown slugs are 404s.
export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS_PAGES.map((p) => ({ slug: p.slug === "index" ? [] : [p.slug] }));
}

async function load(slug: string[] | undefined) {
  const name = slug?.length ? slug.join("/") : "index";
  const page = DOCS_PAGES.find((p) => p.slug === name);
  if (!page) return null;
  const md = await readFile(path.join(process.cwd(), "content", "docs", `${name}.md`), "utf8");
  return { page, blocks: parseMarkdown(md) };
}

export async function generateMetadata({ params }: PageProps<"/docs/[[...slug]]">): Promise<Metadata> {
  const doc = await load((await params).slug);
  const title = doc ? titleOf(doc.blocks) || doc.page.title : "Docs";
  return { title: `${title} · AgentSpace docs` };
}

export default async function DocsPage({ params }: PageProps<"/docs/[[...slug]]">) {
  const doc = await load((await params).slug);
  if (!doc) notFound();
  const index = DOCS_PAGES.findIndex((p) => p.slug === doc.page.slug);
  const prev = DOCS_PAGES[index - 1];
  const next = DOCS_PAGES[index + 1];
  const href = (slug: string) => (slug === "index" ? "/docs" : `/docs/${slug}`);

  return (
    <div className="mx-auto flex w-full max-w-6xl gap-10 px-4 py-6 lg:px-6">
      <nav aria-label="Docs" className="hidden w-56 shrink-0 lg:block">
        <div className="sticky top-6 max-h-[calc(100dvh-3rem)] overflow-y-auto pr-2">
          <Link href="/docs" className="font-display text-lg font-semibold">
            AgentSpace docs
          </Link>
          {DOCS_NAV.map((g) => (
            <div key={g.group} className="mt-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">{g.group}</p>
              <ul className="mt-1.5 space-y-0.5">
                {g.pages.map((p) => (
                  <li key={p.slug}>
                    <Link
                      href={href(p.slug)}
                      aria-current={p.slug === doc.page.slug ? "page" : undefined}
                      className="block rounded-md px-2 py-1 text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-surface-2 aria-[current=page]:font-medium"
                    >
                      {p.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="mt-6 text-xs text-muted">
            <Link href="/demo" className="underline underline-offset-2 hover:text-foreground">
              Live demo
            </Link>{" "}
            ·{" "}
            <a href="https://github.com/KTECeline/agentspace" className="underline underline-offset-2 hover:text-foreground">
              GitHub
            </a>
          </p>
        </div>
      </nav>

      <main className="min-w-0 max-w-3xl flex-1 pb-16">
        <details className="mb-6 rounded-lg border border-border bg-surface lg:hidden">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Docs menu</summary>
          <ul className="border-t border-border px-3 py-2 text-sm">
            {DOCS_PAGES.map((p) => (
              <li key={p.slug}>
                <Link href={href(p.slug)} className="block py-1 hover:underline">
                  {p.title}
                </Link>
              </li>
            ))}
          </ul>
        </details>
        <article>
          <Markdown blocks={doc.blocks} />
        </article>
        <div className="mt-12 flex justify-between gap-4 border-t border-border pt-4 text-sm">
          {prev ? (
            <Link href={href(prev.slug)} className="hover:underline">
              ← {prev.title}
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link href={href(next.slug)} className="text-right hover:underline">
              {next.title} →
            </Link>
          )}
        </div>
        <p className="mt-6 text-xs text-muted">
          <a href={`https://github.com/KTECeline/agentspace/edit/main/web/content/docs/${doc.page.slug}.md`} className="underline underline-offset-2 hover:text-foreground">
            Edit this page on GitHub
          </a>
        </p>
      </main>
    </div>
  );
}
