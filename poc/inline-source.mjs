// HTML parsing normalizes CRLF and lone CR before CSP checks inline content.
// Normalize before both embedding and hashing; omit a source-file UTF-8 BOM.
export function normalizeInlineSource(source) {
  return source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}
