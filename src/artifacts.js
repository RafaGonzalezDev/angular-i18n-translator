import { readFileSync, writeFileSync, renameSync, lstatSync, unlinkSync } from 'node:fs';
import { resolve, relative, isAbsolute, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertNoSymlinks, resolveSafeOutputPath } from './paths.js';

export const ARTIFACT_MANIFEST = '.i18n-artifacts.json';
export const ARTIFACT_MANIFEST_VERSION = 1;

function manifestPath({ projectRoot = process.cwd() } = {}) {
  const target = assertNoSymlinks(resolve(projectRoot, ARTIFACT_MANIFEST));
  try {
    if (!lstatSync(target).isFile()) throw new Error('Artifact manifest must be a regular file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return target;
}

function validateManifest(data, options) {
  if (!data || data.version !== ARTIFACT_MANIFEST_VERSION || !Array.isArray(data.files)) {
    throw new Error('Invalid or unsupported artifact manifest');
  }
  for (const file of data.files) {
    if (typeof file !== 'string' || !file || isAbsolute(file) || win32.isAbsolute(file)
      || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Unsafe artifact manifest path');
    }
    resolveSafeOutputPath(file, options);
  }
  return { version: ARTIFACT_MANIFEST_VERSION, files: [...new Set(data.files)] };
}

/** Read and preflight the ENTIRE manifest before returning any ownership information. */
export function readArtifactManifest(options = {}) {
  const target = manifestPath(options);
  let text;
  try { text = readFileSync(target, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return validateManifest(JSON.parse(text), options);
}

/** Atomically replace ownership metadata; no configuration or file content is stored. */
export function writeArtifactManifest(filePaths, options = {}) {
  const root = resolve(options.projectRoot ?? process.cwd());
  const files = [...new Set(filePaths.map(file => relative(root, resolveSafeOutputPath(file, options)).replace(/\\/g, '/')))];
  const data = validateManifest({ version: ARTIFACT_MANIFEST_VERSION, files: files.sort() }, options);
  const target = manifestPath(options);
  const temp = `${target}.${randomUUID()}.tmp`;
  // Exclusive creation prevents overwriting an unrelated file/symlink.
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    if (manifestPath(options) !== target) throw new Error('Artifact manifest target changed');
    renameSync(temp, target);
  } catch (error) {
    assertNoSymlinks(temp);
    unlinkSync(temp);
    throw error;
  }
  return data;
}

/** Synchronous because CSV conversion callers also have synchronous APIs. */
export function registerArtifacts(filePaths, options = {}) {
  if (!Array.isArray(filePaths)) throw new Error('Artifact filePaths must be an array');
  // Prospective files may be registered before writing. Existing targets must
  // still be regular files; resolveSafeOutputPath checks that and all ancestors.
  const files = filePaths.map(file => resolveSafeOutputPath(file, options));
  const previous = readArtifactManifest(options);
  return writeArtifactManifest([...(previous?.files ?? []), ...files], options);
}
