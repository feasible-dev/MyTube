// null means the byte limit was exceeded. Decoding and validation belong to
// each route, whose existing error codes and UTF-8 policy may differ.
export async function readRequestBytes(request, limit) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
