const BLOCK_MARKER_PATTERNS = [
  /^#{1,6}\s+/m,
  /^>\s+/m,
  /^[-*+]\s+/m,
  /^\d+\.\s+/m,
  /^```/m,
  /^~~~/m,
  /^\|.+\|$/m,
  /^---$/m,
  /^\*\*\*$/m,
  /^___$/m,
];

export function normalizePastedMarkdown(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function looksLikeMarkdownPaste(text: string): boolean {
  const normalized = normalizePastedMarkdown(text).trim();
  if (!normalized) return false;

  return BLOCK_MARKER_PATTERNS.some((pattern) => pattern.test(normalized));
}

interface MarkdownPasteClipboardDataLike {
  types?: Iterable<string> | ArrayLike<string> | null;
  getData: (format: string) => string;
}

interface MarkdownPasteEventLike {
  clipboardData: MarkdownPasteClipboardDataLike | null;
  preventDefault: () => void;
  stopPropagation: () => void;
  stopImmediatePropagation?: () => void;
}

interface MarkdownPasteInterceptionOptions {
  insideCodeLike?: boolean;
}

export function extractMarkdownPaste(
  clipboardData: MarkdownPasteClipboardDataLike | null,
  options: MarkdownPasteInterceptionOptions = {},
): string | null {
  if (!clipboardData || options.insideCodeLike) return null;

  const types = new Set(Array.from(clipboardData.types ?? []));
  if (types.has("Files") || types.has("text/html")) return null;

  const rawText = clipboardData.getData("text/plain");
  if (!looksLikeMarkdownPaste(rawText)) return null;

  return rawText.replace(/\r\n?/g, "\n");
}

export function interceptMarkdownPasteEvent(
  event: MarkdownPasteEventLike,
  options: MarkdownPasteInterceptionOptions = {},
): string | null {
  const markdown = extractMarkdownPaste(event.clipboardData, options);
  if (!markdown) return null;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
  return markdown;
}
