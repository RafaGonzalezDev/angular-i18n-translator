import { lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute, win32, posix } from 'node:path';

const PROTECTED_DIRS = new Set(['.git', 'node_modules', 'src', 'test', 'tests', 'docs', 'source', 'config']);
const PROTECTED_FILE = /^(?:\.env(?:\..*)?|env(?:\..*)?|\.git.*|\.npmrc|package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|(?:i18n\.)?config(?:\..*)?|.*\.config\.[^.]+|(?:tsconfig(?:\.[^.]+)?|jsconfig|angular)\.json|(?:readme|license|agents)(?:\..*)?|\.i18n-artifacts\.json(?:\..*)?|messages\.xlf)$/i;

export function getTranslatedCsvPath(csvPath) {
  if (typeof csvPath !== 'string' || !csvPath) throw new Error('CSV path is required');
  const pathApi = csvPath.includes('\\') ? win32 : posix;
  const { dir, name } = pathApi.parse(csvPath);
  return pathApi.join(dir, `${name}.translated.csv`);
}

/** Reject symbolic links/junctions in every existing component, including ancestors. */
export function assertNoSymlinks(filePath) {
  const absolute = resolve(filePath);
  let current = absolute;
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Unsafe symbolic link or junction: ${current}`);
      // Some Windows reparse-point junctions are reported as directories by lstat.
      // Native realpath still reveals their redirected target (unlike JS realpath).
      if (process.platform === 'win32' && realpathSync.native(current).toLowerCase() !== current.toLowerCase()) {
        throw new Error(`Unsafe redirected path or junction: ${current}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return absolute;
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

function assertSafePath(value, { projectRoot = process.cwd(), protectedPaths = [] } = {}, directory = false) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) throw new Error('Invalid output path');
  // Both separators are checked even on POSIX: a manifest/config must be portable.
  if (value.split(/[\\/]/).includes('..') || (process.platform !== 'win32' && (win32.isAbsolute(value) || value.includes('\\')))) {
    throw new Error(`Unsafe path traversal: ${value}`);
  }
  const root = assertNoSymlinks(resolve(projectRoot));
  const target = resolve(root, value);
  if (target === root || !isWithin(root, target)) throw new Error(`Path must be a strict project descendant: ${value}`);
  const parts = relative(root, target).split(/[\\/]/);
  if (parts.some(part => /[:<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Unsafe filename: ${value}`);
  }
  if (parts.some(part => PROTECTED_DIRS.has(part.toLowerCase()) || PROTECTED_FILE.test(part))) {
    throw new Error(`Protected project path: ${value}`);
  }
  for (const item of protectedPaths) {
    if (!item) continue;
    const protectedPath = resolve(root, item);
    if (isWithin(protectedPath, target) || (directory && isWithin(target, protectedPath))) {
      throw new Error(`Path overlaps a protected path: ${value}`);
    }
  }
  assertNoSymlinks(target);
  try {
    const info = lstatSync(target);
    if (directory ? !info.isDirectory() : !info.isFile()) throw new Error(`Expected ${directory ? 'directory' : 'regular file'}: ${value}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return target;
}

export function resolveSafeOutputPath(filePath, options = {}) {
  return assertSafePath(filePath, options);
}

export function assertSafeDirectory(dir, options = {}) {
  return assertSafePath(dir, options, true);
}
