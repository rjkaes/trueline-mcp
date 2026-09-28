import fc from "fast-check";

// --- File content ---

/** A single realistic line: 1-120 chars, no newlines. */
export const arbLine = fc.stringMatching(/^[^\n\r]{1,120}$/).filter((s) => s.length >= 1);

/** A file as an array of lines (1-20 lines). */
export const arbFileContent = fc.array(arbLine, { minLength: 1, maxLength: 20 });
