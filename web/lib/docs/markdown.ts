/**
 * A small Markdown parser for the docs (/docs). Pure and tested (tests/markdown.test.ts).
 *
 * Supports what the docs use: ATX headings, paragraphs, fenced code, bullet and numbered lists
 * (one level), blockquotes, GFM tables, horizontal rules, and inline `code`, **bold**, *italic*
 * and [links](url). Raw HTML is never passed through: everything becomes typed nodes that the
 * renderer turns into React elements, so docs content can't inject markup.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { t: "h"; level: 1 | 2 | 3 | 4; id: string; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "ul" | "ol"; items: Inline[][] }
  | { t: "quote"; c: Block[] }
  | { t: "table"; head: Inline[][]; rows: Inline[][][]; align: ("left" | "right" | "center" | null)[] }
  | { t: "hr" };

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Only these link targets are rendered as links; anything else (javascript:, data:) is text. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^(https?:\/\/|mailto:|\/|#|\.\.?\/)/i.test(h)) return h;
  if (/^[a-z0-9-]+(\.md)?(#[\w-]*)?$/i.test(h)) return h; // a sibling doc
  return null;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\\" && i + 1 < src.length && /[\\`*_[\]()#|]/.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ t: "code", v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (src.startsWith("**", i)) {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "strong", c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && src[i + 1] !== ch && src[i + 1] !== " ") {
      const end = src.indexOf(ch, i + 1);
      const wordStart = ch === "*" || i === 0 || /\W/.test(src[i - 1]!);
      if (end > i + 1 && wordStart && src[end - 1] !== " ") {
        flush();
        out.push({ t: "em", c: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const close = src.indexOf("](", i);
      const end = close > i ? src.indexOf(")", close + 2) : -1;
      if (close > i && end > close) {
        flush();
        const label = parseInline(src.slice(i + 1, close));
        const href = safeHref(src.slice(close + 2, end));
        out.push(...(href ? [{ t: "link", href, c: label } as const] : label));
        i = end + 1;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (c === "\\" && trimmed[i + 1] === "|") {
      cell += "|";
      i += 1;
    } else if (c === "`") {
      inCode = !inCode;
      cell += c;
    } else if (c === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

const isTableSep = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const LIST = /^\s*([-*]|\d+[.)])\s+(.*)$/;

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const ids = new Map<string, number>();
  let i = 0;

  const uniqueId = (text: string) => {
    const base = slugify(text) || "section";
    const n = ids.get(base) ?? 0;
    ids.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) body.push(lines[i++]!);
      i += 1; // closing fence
      blocks.push({ t: "code", lang: fence[2] ?? "", v: body.join("\n") });
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const text = h[2]!;
      blocks.push({ t: "h", level: h[1]!.length as 1 | 2 | 3 | 4, id: uniqueId(text.replace(/[*_`[\]]/g, "")), c: parseInline(text) });
      i += 1;
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ t: "hr" });
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      blocks.push({ t: "quote", c: parseMarkdown(body.join("\n")) });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null,
      );
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(splitRow(lines[i++]!).map(parseInline));
      blocks.push({ t: "table", head: head.map(parseInline), rows, align });
      continue;
    }
    const li = line.match(LIST);
    if (li) {
      const ordered = /\d/.test(li[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(LIST);
        if (m && /\d/.test(m[1]!) === ordered && !/^\s{2,}/.test(lines[i]!)) {
          items.push(m[2]!);
        } else if (lines[i]!.trim() && /^\s+/.test(lines[i]!) && items.length) {
          items[items.length - 1] += " " + lines[i]!.trim(); // continuation or nested line
        } else break;
        i += 1;
      }
      blocks.push({ t: ordered ? "ol" : "ul", items: items.map(parseInline) });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,4}\s|\s*(```|~~~)|\s*>)/.test(lines[i]!) &&
      !LIST.test(lines[i]!) &&
      !(lines[i]!.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]!))
    ) {
      para.push(lines[i++]!.trim());
    }
    blocks.push({ t: "p", c: parseInline(para.join(" ")) });
  }
  return blocks;
}

/** The text of the first level-1 heading, for the page title. */
export function titleOf(blocks: Block[]): string {
  const h1 = blocks.find((b): b is Extract<Block, { t: "h" }> => b.t === "h" && b.level === 1);
  return h1 ? plain(h1.c) : "";
}

export function plain(c: Inline[]): string {
  return c.map((n) => (n.t === "text" || n.t === "code" ? n.v : plain(n.c))).join("");
}
