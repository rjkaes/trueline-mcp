// ==============================================================================
// File Access Checking
// ==============================================================================
//
// Generalized version of truelineCanAccess — determines whether trueline can
// serve a given file path. Shares the containment check (isContained) with
// src/tools/shared.ts and mirrors its deny-pattern check. Platform-agnostic:
// caller passes the project directory.

import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { isContained, resolveAllowedDirs } from "../../src/allowed-dirs.js";
import { readToolDenyPatterns, evaluateFilePath } from "../../src/security.js";

/**
 * Create an access-checker function bound to a project directory.
 * Pre-resolves allowed directories once, then returns a fast async checker.
 *
 * @param {string | undefined} projectDir
 * @returns {Promise<(filePath: string, toolName: string) => Promise<boolean>>}
 */
export async function createAccessChecker(projectDir) {
  if (!projectDir) return async () => false;

  let realBase;
  try {
    realBase = await realpath(projectDir);
  } catch {
    return async () => false;
  }

  // Reuse the server/CLI allow-list resolver so the hook doesn't drift.
  const allowedBases = [realBase, ...(await resolveAllowedDirs())];

  /**
   * @param {string} filePath
   * @param {string} toolName - "Read" or "Edit"
   * @returns {Promise<boolean>}
   */
  return async function canAccess(filePath, toolName) {
    const resolvedPath = filePath.startsWith("/") ? filePath : resolve(projectDir, filePath);

    let realPath;
    try {
      realPath = await realpath(resolvedPath);
    } catch {
      return false;
    }

    if (!isContained(realPath, allowedBases)) return false;

    // Deny rules match the requested path and the file it resolves to, as
    // checkPathBoundary does, so a rule that names a symlink applies too.
    const denyGlobs = await readToolDenyPatterns(toolName, projectDir);
    for (const candidate of new Set([realPath, resolve(resolvedPath)])) {
      if (evaluateFilePath(candidate, denyGlobs).denied) return false;
    }
    return true;
  };
}
