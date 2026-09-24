import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, safeHref, titleOf } from "../lib/docs/markdown";

describe("parseInline", () => {
  it("handles code, bold, italic and links", () => {
    expect(parseInline("run `make test` **now**, *please*: [docs](/docs/x)")).toEqual([
      { t: "text", v: "run " },
      { t: "code", v: "make test" },
      { t: "text", v: " " },
      { t: "strong", c: [{ t: "text", v: "now" }] },
      { t: "text", v: ", " },
      { t: "em", c: [{ t: "text", v: "please" }] },
      { t: "text", v: ": " },
      { t: "link", href: "/docs/x", c: [{ t: "text", v: "docs" }] },
    ]);
  });

  it("keeps markup inside code spans literal", () => {
    expect(parseInline("`**not bold** [x](y)`")).toEqual([{ t: "code", v: "**not bold** [x](y)" }]);
  });

  it("leaves snake_case words alone", () => {
    expect(parseInline("capture_content and tokens_in")).toEqual([{ t: "text", v: "capture_content and tokens_in" }]);
  });

  it("drops unsafe link targets but keeps the text", () => {
    expect(parseInline("[click](javascript:alert(1))")).toEqual([{ t: "text", v: "click" }, { t: "text", v: ")" }]);
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("adapters-langgraph")).toBe("adapters-langgraph");
  });
});

describe("parseMarkdown", () => {
  const doc = [
    "# Title",
    "",
    "A paragraph",
    "on two lines.",
    "",
    "## Install it",
    "",
    "```bash",
    "pip install agentspace-sdk",
    "# a comment, not a heading",
    "```",
    "",
    "- one",
    "- two",
    "  continued",
    "",
    "1. first",
    "2. second",
    "",
    "> **Note:** careful.",
    "",
    "| Name | Value |",
    "|---|---:|",
    "| `a|b` | 1 |",
    "| c | 2 |",
    "",
    "## Install it",
    "---",
  ].join("\n");
  const blocks = parseMarkdown(doc);

  it("parses every block type", () => {
    expect(blocks.map((b) => b.t)).toEqual(["h", "p", "h", "code", "ul", "ol", "quote", "table", "h", "hr"]);
    expect(titleOf(blocks)).toBe("Title");
  });

  it("keeps code blocks verbatim", () => {
    expect(blocks[3]).toEqual({ t: "code", lang: "bash", v: "pip install agentspace-sdk\n# a comment, not a heading" });
  });

  it("joins paragraph and list continuation lines", () => {
    expect(blocks[1]).toEqual({ t: "p", c: [{ t: "text", v: "A paragraph on two lines." }] });
    expect(blocks[4]).toMatchObject({ t: "ul", items: [[{ v: "one" }], [{ v: "two continued" }]] });
  });

  it("gives headings unique ids", () => {
    expect([blocks[2], blocks[8]].map((b) => (b.t === "h" ? b.id : ""))).toEqual(["install-it", "install-it-1"]);
  });

  it("parses tables with alignment and pipes inside code", () => {
    const table = blocks[7];
    expect(table).toMatchObject({ t: "table", align: [null, "right"], rows: [[[{ t: "code", v: "a|b" }], [{ v: "1" }]], [[{ v: "c" }], [{ v: "2" }]]] });
  });
});
