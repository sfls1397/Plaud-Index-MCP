import os from "node:os";
import path from "node:path";

export const PLAUD_INDEX_DIR_NAME = ".plaud-index-mcp";
export const CONFIG_FILE_NAME = "config.json";
export const VECTOR_INDEX_DIR_NAME = "vector-index";
export const LOCK_FILE_NAME = "indexer.lock";
export const META_FILE_NAME = "index-meta.json";

export interface PathOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}

/**
 * Directory that holds config.json, indexer.lock, and vector-index.
 * Always under the user home directory in production. Config.json cannot
 * override this path (treated as data, not instructions).
 *
 * `PLAUD_INDEX_HOME` is a test/dev override only.
 */
export function getPlaudIndexDir(options: PathOptions = {}): string {
  const env = options.env || process.env;
  if (env.PLAUD_INDEX_HOME && env.PLAUD_INDEX_HOME.trim()) {
    return path.resolve(env.PLAUD_INDEX_HOME);
  }
  const homedir = options.homedir || (() => os.homedir());
  const home = env.HOME || homedir();
  return path.join(home, PLAUD_INDEX_DIR_NAME);
}

export function getConfigPath(options: PathOptions = {}): string {
  return path.join(getPlaudIndexDir(options), CONFIG_FILE_NAME);
}

export function getVectorIndexDir(options: PathOptions = {}): string {
  return path.join(getPlaudIndexDir(options), VECTOR_INDEX_DIR_NAME);
}

export function getLockFilePath(options: PathOptions = {}): string {
  return path.join(getPlaudIndexDir(options), LOCK_FILE_NAME);
}

export function getMetaFilePath(options: PathOptions = {}): string {
  return path.join(getPlaudIndexDir(options), META_FILE_NAME);
}
