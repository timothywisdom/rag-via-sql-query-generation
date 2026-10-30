const MARKDOWN_PATTERNS = [
  /(^|\n)```/,
  /(^|\n)#{1,6} \S/,
  /(^|\n)\s*[-*+] \S/,
  /(^|\n)\s*\d+\. \S/,
  /\*\*[^*\n]+\*\*/,
  /__[^_\n]+__/,
  /\[[^\]\n]+\]\([^)\s]+\)/,
  /(^|\n)\s*> \S/,
  /(^|\n)\|.*\|.*\n\|?\s*:?-{3,}/,
];

export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_PATTERNS.some((pattern) => pattern.test(text));
}
