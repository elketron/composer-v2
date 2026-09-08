// Binary-file detection (SRV-021): a text read must refuse a file that is
// actually bytes. The heuristic is shared — a NUL byte, or an implausibly
// high ratio of control bytes over the sampled head — while each caller
// keeps its own response (the docs reader rejects, the assistant reader
// reports `binary: true`).

/** A sampled head that is not text (a NUL, or >30% control bytes). */
export function looksBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  if (buffer.length === 0) return false;
  let nonPrintable = 0;
  for (const byte of buffer) {
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable += 1;
  }
  return nonPrintable / buffer.length > 0.3;
}