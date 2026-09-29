/**
 * Streaming XML outline extraction.
 *
 * Uses a SAX-style state machine over the existing line splitter to extract
 * element structure without loading the full document into memory. Only tracks
 * open/close/self-closing elements and processing instructions; skips comments,
 * CDATA sections, and DTD declarations.
 */
import { splitLines } from "../line-splitter.ts";
import type { OutlineEntry } from "./extract.ts";

// ==============================================================================
// SAX state machine
// ==============================================================================

const State = {
  Text: 0,
  TagOpen: 1, // saw '<', collecting tag content
  Comment: 2, // inside <!-- ... -->
  CData: 3, // inside <![CDATA[ ... ]]>
  PI: 4, // inside <? ... ?>
  DocType: 5, // inside <!DOCTYPE ... >
} as const;

type State = (typeof State)[keyof typeof State];

interface ElementFrame {
  tagName: string;
  depth: number;
  startLine: number;
  /** Opening tag text for the signature (tag name + attributes), truncated */
  signature: string;
}

/**
 * Extract outline entries from an XML file by streaming it line-by-line.
 *
 * Returns entries for each element at depth <= maxDepth, plus processing
 * instructions at depth 0. Elements deeper than maxDepth are skipped entirely
 * (their content is not buffered).
 */
export async function extractXmlOutline(
  filePath: string,
  maxDepth = Infinity,
): Promise<{
  entries: OutlineEntry[];
  totalLines: number;
}> {
  const entries: OutlineEntry[] = [];
  const stack: ElementFrame[] = [];
  let totalLines = 0;

  let state: State = State.Text;
  // Accumulates tag content when state is TagOpen, PI, Comment, or CData
  let buf = "";
  // Inside a DOCTYPE's internal subset ([...]), where '>' ends a markup declaration
  let inDocSubset = false;
  // Line where the current tag/comment/PI started
  let tokenStartLine = 0;

  function addElement(startLine: number, endLine: number, depth: number, text: string): void {
    if (depth <= maxDepth) {
      entries.push({ startLine, endLine, depth, nodeType: "element", text });
    }
  }

  /** Process a complete tag (everything between < and >, exclusive). */
  function handleTag(content: string, endLine: number): void {
    // Self-closing: <foo attr="val" />
    if (content.endsWith("/")) {
      const trimmed = content.slice(0, -1).trim();
      const tagName = extractTagName(trimmed);
      addElement(tokenStartLine, endLine, stack.length, formatSignature(tagName, trimmed, true));
      return;
    }

    // Closing tag: </foo>
    if (content.startsWith("/")) {
      const tagName = extractTagName(content.slice(1));
      // Pop the stack back to the matching open tag (tolerates mild mismatches)
      const i = stack.findLastIndex((f) => f.tagName === tagName);
      // No matching open tag found; ignore the close tag
      if (i === -1) return;
      const frame = stack[i];
      // Pop everything from i onward (handles mismatched nesting gracefully)
      stack.length = i;
      addElement(frame.startLine, endLine, frame.depth, frame.signature);
      return;
    }

    // Open tag: <foo attr="val">
    const tagName = extractTagName(content);
    const depth = stack.length;
    stack.push({
      tagName,
      depth,
      startLine: tokenStartLine,
      signature: formatSignature(tagName, content),
    });
  }

  /** Process a complete processing instruction (everything between <? and ?>). */
  function handlePI(content: string, endLine: number): void {
    // Only include top-level PIs
    if (stack.length > 0) return;

    const trimmed = content.trim();
    const sig = trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
    entries.push({
      startLine: tokenStartLine,
      endLine,
      depth: 0,
      nodeType: "processing_instruction",
      text: `<?${sig}?>`,
    });
  }

  // ==============================================================================
  // Stream through file line by line
  // ==============================================================================

  for await (const { lineBytes, lineNumber } of splitLines(filePath, { detectBinary: true })) {
    totalLines = lineNumber;
    const line = lineBytes.toString("utf-8");

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      switch (state) {
        case State.Text:
          if (ch === "<") {
            buf = "";
            // Peek ahead to identify the token type
            const rest = line.slice(i + 1);
            if (rest.startsWith("!--")) {
              state = State.Comment;
              i += 3; // skip '!--'
            } else if (rest.startsWith("![CDATA[")) {
              state = State.CData;
              i += 8; // skip '![CDATA['
            } else if (rest.startsWith("!DOCTYPE") || rest.startsWith("!doctype")) {
              state = State.DocType;
              i += 8; // skip '!DOCTYPE'
            } else if (rest.startsWith("?")) {
              state = State.PI;
              tokenStartLine = lineNumber;
              i += 1; // skip '?'
            } else {
              state = State.TagOpen;
              tokenStartLine = lineNumber;
            }
          }
          break;

        case State.TagOpen:
          if (ch === ">") {
            handleTag(buf.trim(), lineNumber);
            state = State.Text;
          } else {
            buf += ch;
          }
          break;

        case State.PI:
          // Looking for '?>'
          if (ch === "?" && i + 1 < line.length && line[i + 1] === ">") {
            handlePI(buf, lineNumber);
            state = State.Text;
            i++; // skip '>'
          } else {
            buf += ch;
          }
          break;

        case State.Comment:
          // Looking for '-->'
          if (ch === "-" && line.slice(i, i + 3) === "-->") {
            state = State.Text;
            i += 2; // skip '->'
          }
          // Intentionally not buffering comment content
          break;

        case State.CData:
          // Looking for ']]>'
          if (ch === "]" && line.slice(i, i + 3) === "]]>") {
            state = State.Text;
            i += 2; // skip ']>'
          }
          break;

        case State.DocType: {
          // Only a '>' outside the internal subset closes the DOCTYPE.
          // TODO: a quoted ']' or '>' in an entity value still ends the subset or DOCTYPE early.
          if (ch === "[") {
            inDocSubset = true;
          } else if (ch === "]") {
            inDocSubset = false;
          } else if (ch === ">" && !inDocSubset) {
            state = State.Text;
          }
          break;
        }
      }
    }

    // If we're mid-tag, add a space for the line break (attributes may span lines)
    if (state === State.TagOpen || state === State.PI) {
      buf += " ";
    }
  }

  // Any unclosed elements on the stack get entries ending at EOF
  while (stack.length > 0) {
    const frame = stack.pop()!;
    addElement(frame.startLine, totalLines, frame.depth, frame.signature);
  }

  // Sort by startLine (close-tag entries from the stack are appended out of order)
  entries.sort((a, b) => a.startLine - b.startLine || a.depth - b.depth);

  return { entries, totalLines };
}

// ==============================================================================
// Helpers
// ==============================================================================

/** Extract the tag name from tag content (everything before the first whitespace or /). */
function extractTagName(content: string): string {
  const trimmed = content.trim();
  const end = trimmed.search(/[\s/]/);
  return end === -1 ? trimmed : trimmed.slice(0, end);
}

/** Format a compact signature from tag name and full tag content (open or self-closing tag). */
function formatSignature(tagName: string, content: string, selfClosing = false): string {
  const trimmed = content.trim().replace(/\s+/g, " ");
  const close = selfClosing ? " />" : ">";
  const sig = `<${trimmed}${close}`;
  return sig.length > 200 ? `<${tagName} ...${close}` : sig;
}
