/** "Every day…" mid-sentence, without flattening "POST requests" to "post requests". */
export function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;
}
