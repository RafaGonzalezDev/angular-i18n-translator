import { lstatSync, readdirSync } from 'node:fs';
import { rm, rmdir } from 'node:fs/promises';
import { resolve, relative, dirname, join, isAbsolute } from 'node:path';
import { assertSafeDirectory, resolveSafeOutputPath, assertNoSymlinks } from './paths.js';
import { readArtifactManifest, writeArtifactManifest } from './artifacts.js';

function exists(target) {
  try { lstatSync(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function within(parent, target) {
  const rel = relative(parent, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

/** Remove only manifest-owned files. Foreign files and unowned empty directories survive. */
export async function cleanAll(paths, options = {}) {
  const { dryRun = false, projectRoot = process.cwd() } = options;
  const safety = { projectRoot, protectedPaths: [...(options.protectedPaths ?? []), paths.sourceFile, paths.configFile].filter(Boolean) };
  const removed = [], planned = [], warnings = [];
  // Preflight ALL requested targets before consulting the manifest or deleting anything.
  const batch = paths.batchDir ? assertSafeDirectory(paths.batchDir, safety) : null;
  const directories = [
    ...(batch ? [assertSafeDirectory(join(batch, 'pending'), safety), assertSafeDirectory(join(batch, 'translated'), safety)] : []),
    ...(paths.outputDir ? [assertSafeDirectory(paths.outputDir, safety)] : []),
  ];
  const exact = [paths.csvPath, paths.translatedCsvPath].filter(Boolean).map(file => resolveSafeOutputPath(file, safety));
  const manifest = readArtifactManifest(safety);
  if (!manifest) {
    warnings.push('No artifact manifest found; existing artifacts were preserved. Review old artifacts and clean them manually.');
    return { removed, planned, warnings };
  }
  const owned = manifest.files.map(file => resolveSafeOutputPath(file, safety));
  const selected = owned.filter(file => exact.includes(file) || directories.some(dir => within(dir, file)));
  const files = selected.filter(exists);
  for (const file of selected) {
    if (!files.includes(file)) warnings.push(`Registered artifact is missing; no deletion needed: ${file}`);
  }
  const candidates = new Set();
  for (const file of files) {
    let parent = dirname(file);
    while (directories.some(dir => within(dir, parent)) || (batch && parent === batch)) {
      candidates.add(assertSafeDirectory(parent, safety));
      parent = dirname(parent);
    }
    if (batch && directories.some(dir => within(dir, file)) && within(batch, file)) candidates.add(batch);
  }
  const virtualRemoved = new Set(files);
  const emptyDirectories = [...candidates].sort((a, b) => b.length - a.length).filter(dir => {
    const empty = readdirSync(dir).every(entry => virtualRemoved.has(join(dir, entry)));
    if (empty) virtualRemoved.add(dir);
    return empty;
  });
  planned.push(...files, ...emptyDirectories);
  if (dryRun) return { removed, planned, warnings };

  for (const file of files) {
    // Revalidate the exact resolved target immediately before the non-recursive removal.
    if (resolveSafeOutputPath(file, safety) !== file || assertNoSymlinks(file) !== file) throw new Error('Cleanup target changed');
    await rm(file, { force: true });
    removed.push(file);
  }
  for (const dir of emptyDirectories) {
    if (assertSafeDirectory(dir, safety) !== dir) throw new Error('Cleanup directory target changed');
    // rmdir never recursively removes contents; races introducing a foreign file are safe.
    try { await rmdir(dir); removed.push(dir); }
    catch (error) {
      if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error;
      if (error.code !== 'ENOENT') warnings.push(`Directory preserved because it is no longer empty: ${dir}`);
    }
  }
  writeArtifactManifest(owned.filter(file => !selected.includes(file)), safety);
  return { removed, planned, warnings };
}

export default { cleanAll };
