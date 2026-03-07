import { dirname, resolve, sep } from "node:path";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import type { ToolResult } from "./types.ts";
import { errorResult, textResult } from "./types.ts";
import { handleRead } from "./read.ts";

// ==============================================================================
// Path validation for write (handles both new and existing files)
// ==============================================================================

// Unlike validatePath in shared.ts (which requires the file to exist), this
// validates the *parent directory* for new files and the file itself for
// existing ones. The security invariant is the same: the resolved path must
// fall inside an allowed directory.

interface ValidateWritePathOk {
  ok: true;
  resolvedPath: string;
  exists: boolean;
}
type ValidateWritePathResult = ValidateWritePathOk | { ok: false; error: ToolResult };

async function validateWritePath(
  file_path: string,
  projectDir: string | undefined,
  allowedDirs: string[] = [],
): Promise<ValidateWritePathResult> {
  const resolvedPath = file_path.startsWith("/") ? file_path : resolve(projectDir ?? process.cwd(), file_path);

  // Check if file already exists
  let realPath: string;
  let exists = false;
  try {
    realPath = await realpath(resolvedPath);
    exists = true;
    // Existing path must be a regular file
    const fileStat = await stat(realPath);
    if (!fileStat.isFile()) {
      return { ok: false, error: errorResult(`"${file_path}" is not a regular file`) };
    }
  } catch {
    // File doesn't exist; validate containment by walking up to the
    // nearest existing ancestor. Intermediate directories may not exist
    // yet (create_directories will create them later).
    realPath = resolvedPath;
    let ancestor = dirname(resolvedPath);
    let realAncestor: string | undefined;
    while (ancestor !== dirname(ancestor)) {
      try {
        realAncestor = await realpath(ancestor);
        break;
      } catch {
        ancestor = dirname(ancestor);
      }
    }
    if (!realAncestor) {
      return { ok: false, error: errorResult(`No accessible ancestor directory for "${file_path}"`) };
    }
    // Reconstruct the resolved path relative to the real ancestor
    const tail = resolvedPath.slice(ancestor.length);
    realPath = realAncestor + tail;
  }

  // Containment check
  let realBase: string;
  try {
    realBase = await realpath(projectDir ? projectDir : process.cwd());
  } catch {
    return { ok: false, error: errorResult("Project directory not found or inaccessible") };
  }
  const resolvedAllowed = await Promise.all(allowedDirs.map((d) => realpath(d).catch(() => d)));
  const allBases = [realBase, ...resolvedAllowed];
  const isContained = allBases.some((base) => realPath === base || realPath.startsWith(base + sep));
  if (!isContained) {
    return { ok: false, error: errorResult(`Access denied: "${file_path}" is outside the project directory`) };
  }

  return { ok: true, resolvedPath: realPath, exists };
}

// ==============================================================================
// Write handler
// ==============================================================================

interface WriteParams {
  file_path: string;
  content: string;
  create_directories?: boolean;
  projectDir?: string;
  allowedDirs?: string[];
}

export async function handleWrite(params: WriteParams): Promise<ToolResult> {
  const { file_path, content, projectDir, allowedDirs } = params;
  const createDirs = params.create_directories !== false;

  const validated = await validateWritePath(file_path, projectDir, allowedDirs);
  if (!validated.ok) return validated.error;

  const { resolvedPath } = validated;

  try {
    if (createDirs) {
      await mkdir(dirname(resolvedPath), { recursive: true });
    }
    await writeFile(resolvedPath, content, "utf-8");
  } catch (err: unknown) {
    return errorResult(`Write failed: ${(err as Error).message}`);
  }

  // Reuse trueline_read to compute a checksum for verification. This
  // guarantees the checksum matches what a subsequent trueline_read would
  // return, regardless of EOL style.
  const readResult = await handleRead({ file_path: resolvedPath, projectDir, allowedDirs });
  const checksumMatch = readResult.content[0].text.match(/checksum: (\S+)/);
  const checksum = checksumMatch ? checksumMatch[1] : "0-0:00000000";

  const verb = validated.exists ? "overwritten" : "created";
  return textResult(`File ${verb}: ${file_path}\n\nchecksum: ${checksum}`);
}
