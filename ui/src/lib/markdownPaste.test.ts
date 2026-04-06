import { describe, expect, it, vi } from "vitest";
import {
  extractMarkdownPaste,
  interceptMarkdownPasteEvent,
  looksLikeMarkdownPaste,
  normalizePastedMarkdown,
} from "./markdownPaste";

describe("markdownPaste", () => {
  it("normalizes windows line endings", () => {
    expect(normalizePastedMarkdown("a\r\nb\r\n")).toBe("a\nb\n");
  });

  it("normalizes old mac line endings", () => {
    expect(normalizePastedMarkdown("a\rb\r")).toBe("a\nb\n");
  });

  it("treats markdown blocks as markdown paste", () => {
    expect(looksLikeMarkdownPaste("# Title\n\n- item 1\n- item 2")).toBe(true);
  });

  it("treats a fenced code block as markdown paste", () => {
    expect(looksLikeMarkdownPaste("```\nconst x = 1;\n```")).toBe(true);
  });

  it("treats a tilde fence as markdown paste", () => {
    expect(looksLikeMarkdownPaste("~~~\nraw\n~~~")).toBe(true);
  });

  it("treats a blockquote as markdown paste", () => {
    expect(looksLikeMarkdownPaste("> some quoted text")).toBe(true);
  });

  it("treats an ordered list as markdown paste", () => {
    expect(looksLikeMarkdownPaste("1. first\n2. second")).toBe(true);
  });

  it("treats a table row as markdown paste", () => {
    expect(looksLikeMarkdownPaste("| col1 | col2 |")).toBe(true);
  });

  it("treats horizontal rules as markdown paste", () => {
    expect(looksLikeMarkdownPaste("---")).toBe(true);
    expect(looksLikeMarkdownPaste("***")).toBe(true);
    expect(looksLikeMarkdownPaste("___")).toBe(true);
  });

  it("leaves plain multi-line text on the native paste path", () => {
    expect(looksLikeMarkdownPaste("first paragraph\nsecond paragraph")).toBe(false);
  });

  it("leaves single-line plain text on the native paste path", () => {
    expect(looksLikeMarkdownPaste("just a sentence")).toBe(false);
  });

  it("extracts markdown paste and normalizes line endings", () => {
    const clipboardData = {
      types: ["text/plain"],
      getData: (format: string) => format === "text/plain"
        ? "```ts\r\nconst x = 1;\r\n```"
        : "",
    };

    expect(extractMarkdownPaste(clipboardData)).toBe("```ts\nconst x = 1;\n```");
  });

  it("does not intercept markdown paste when html is present", () => {
    const clipboardData = {
      types: ["text/plain", "text/html"],
      getData: (format: string) => format === "text/plain" ? "```ts\nconst x = 1;\n```" : "<pre>code</pre>",
    };

    expect(extractMarkdownPaste(clipboardData)).toBeNull();
  });

  it("does not intercept markdown paste inside code-like selections", () => {
    const clipboardData = {
      types: ["text/plain"],
      getData: () => "```ts\nconst x = 1;\n```",
    };

    expect(extractMarkdownPaste(clipboardData, { insideCodeLike: true })).toBeNull();
  });

  it("stops the native paste event once markdown is intercepted", () => {
    const event = {
      clipboardData: {
        types: ["text/plain"],
        getData: () => "```ts\nconst x = 1;\n```",
      },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };

    expect(interceptMarkdownPasteEvent(event)).toBe("```ts\nconst x = 1;\n```");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });
});
