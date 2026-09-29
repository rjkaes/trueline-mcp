import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as current from "../src/line-splitter.ts";
import { importBaseline, measureSpeedup } from "./perf-helpers.ts";

const baseline = await importBaseline<typeof current>("52bde6c", "src/line-splitter.ts");

const CHUNK_SIZE = 65536;

function sourceLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `  const invoice_${i} = await ledger.post(customerId, ${i * 17});`);
}

function toChunks(bytes: Buffer, chunkSize: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(Buffer.from(bytes.subarray(offset, offset + chunkSize)));
  }
  return chunks;
}

async function* replay(chunks: Buffer[]): AsyncGenerator<Buffer> {
  yield* chunks;
}

type Splitter = typeof current.splitChunks;

async function drain(split: Splitter, chunks: Buffer[]): Promise<number> {
  let count = 0;
  for await (const _ of split(replay(chunks), { detectBinary: true })) count++;
  return count;
}

/** Everything a consumer can observe: yielded lines, then the error (if any). */
async function observe(split: Splitter, chunks: Buffer[], detectBinary: boolean) {
  const lines: string[] = [];
  try {
    for await (const line of split(replay(chunks), { detectBinary })) {
      lines.push(`${line.lineNumber}:${line.lineBytes.toString("hex")}:${line.eolBytes.toString("hex")}`);
    }
  } catch (err) {
    return { lines, error: (err as Error).message };
  }
  return { lines, error: null };
}

describe("splitChunks performance", () => {
  for (const [label, eol] of [
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ] as const) {
    test(`at least 2x faster than baseline on a 10k-line ${label} file`, async () => {
      const chunks = toChunks(Buffer.from(`${sourceLines(10_000).join(eol)}${eol}`), CHUNK_SIZE);
      expect(await drain(current.splitChunks, chunks)).toBe(10_000);

      const speedup = await measureSpeedup(
        `splitChunks ${label}`,
        () => drain(baseline.splitChunks, chunks),
        () => drain(current.splitChunks, chunks),
      );
      expect(speedup).toBeGreaterThanOrEqual(2);
    });
  }
});

describe("splitChunks matches baseline output", () => {
  // Small alphabet and tiny chunks force CR/LF pairs, NULs, and lines
  // to straddle chunk boundaries far more often than real files do.
  const content = fc.array(fc.constantFrom(0x61, 0x62, 0x0d, 0x0a, 0x00), { maxLength: 60 });

  test("for random content, chunking, and binary detection", async () => {
    await fc.assert(
      fc.asyncProperty(
        content,
        fc.integer({ min: 1, max: 9 }),
        fc.boolean(),
        async (bytes, chunkSize, detectBinary) => {
          const chunks = toChunks(Buffer.from(bytes), chunkSize);
          const expected = await observe(baseline.splitChunks, chunks, detectBinary);
          expect(await observe(current.splitChunks, chunks, detectBinary)).toEqual(expected);
        },
      ),
      { numRuns: 2000 },
    );
  });
});
