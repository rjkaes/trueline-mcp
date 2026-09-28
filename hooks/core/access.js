// ==============================================================================
// File Access Checking
// ==============================================================================
//
// Generalized version of truelineCanAccess — determines whether trueline can
// serve a given file path. Mirrors the containment + deny-pattern checks in
// src/tools/shared.ts. Platform-agnostic: caller passes the project directory.

import { resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { resolveAllowedDirs } from "../../src/allowed-dirs.js";
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

    const isContained = allowedBases.some((base) => realPath === base || realPath.startsWith(base + sep));
    if (!isContained) return false;

    // Check deny patterns for this tool.
    const denyGlobs = await readToolDenyPatterns(toolName, projectDir);
    const { denied } = evaluateFilePath(realPath, denyGlobs);
    return !denied;
  };
}
