/**
 * Directory-root pre-approval for plain local `write` and `edit` calls.
 *
 * `allowPaths` in the agent-directory `auto-mode.json` names directories whose descendants those
 * two tools may mutate without a model request or a prompt. This is an approval policy, not
 * containment: the check runs before the tool performs its I/O, so a path swapped between the
 * check and the write (a re-pointed symlink, a fresh hard link) is not caught. Anything the check
 * cannot establish goes to the classifier instead of gaining an allow:
 *
 * - spellings omp resolves specially: internal URLs, `~` and `@` shorthands, archive and SQLite
 *   selectors (`:`, `?`), hashline headers, backslashes, Unicode spaces, `..` segments;
 * - a target whose real location, or the real location of its deepest existing ancestor, is not
 *   strictly beneath the real root, or whose apparent location is not beneath the root as
 *   configured; dangling links; non-regular or multiply-linked files;
 * - a missing relative `edit` target, which omp's edit engine may resolve to a different
 *   workspace file by suffix;
 * - an edit payload for which omp's own inspection reports no targets.
 */
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** omp's static projection of an edit payload (`editInspect` from `@oh-my-pi/pi-natives`). */
export type EditInspect = (
  mode: string,
  argsJson: string,
) => {
  readonly paths: readonly string[];
  readonly entries: readonly { readonly path: string }[];
  readonly fileOps: readonly { readonly path: string; readonly to?: string }[];
};

/**
 * The edit grammar depends on a mode the extension cannot observe (the active model, environment,
 * and settings choose it), so every mode inspects the payload and all of their targets must be
 * approved. A mode that cannot parse the payload reports nothing, as it does for omp's own
 * approval tier.
 */
const EDIT_MODES = ["replace", "patch", "apply_patch", "hashline", "sloppy"] as const;

/** Characters omp gives selector, URL, escape, or control meaning, and Unicode spaces it rewrites. */
const SPECIAL_CHARS = /[:?\\\x00-\x1f\x7f\u00A0\u2000-\u200A\u202F\u205F\u3000]/;

export interface PathTargets {
  readonly paths: readonly string[];
  /** Whether a missing relative target may resolve somewhere other than its literal location. */
  readonly recoversMissingRelative: boolean;
}

/** The single file a `write` call replaces, or `undefined` for a malformed call. */
export const writeTargets = (input: Record<string, unknown>): PathTargets | undefined =>
  typeof input["path"] === "string" ? { paths: [input["path"]], recoversMissingRelative: false } : undefined;

/**
 * Every file an `edit` payload touches under any mode, including move destinations, or
 * `undefined` when no mode reports a target or an inspection fails outright.
 */
export const editTargets = (input: object, inspect: EditInspect): PathTargets | undefined => {
  const json = JSON.stringify(input);
  const paths = new Set<string>();
  for (const mode of EDIT_MODES) {
    let inspection: ReturnType<EditInspect>;
    try {
      inspection = inspect(mode, json);
    } catch {
      return undefined;
    }
    for (const target of inspection.paths) paths.add(target);
    for (const entry of inspection.entries) paths.add(entry.path);
    for (const op of inspection.fileOps) {
      paths.add(op.path);
      if (op.to !== undefined) paths.add(op.to);
    }
  }
  return paths.size === 0 ? undefined : { paths: [...paths], recoversMissingRelative: true };
};

const isPlainPath = (target: string): boolean =>
  target !== "" &&
  target === target.trim() &&
  !SPECIAL_CHARS.test(target) &&
  !/^[@~[]/.test(target) &&
  !/^\/+$/.test(target) &&
  !target.split("/").includes("..");

/** Whether `target` is a strict descendant of `root`, comparing path components. */
const beneath = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel !== "" && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
};

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Where a write to `absolute` lands: the real path of an existing single-link regular file, or of
 * the deepest existing ancestor directory with the missing components appended. `undefined` when
 * that cannot be established, including dangling links and hard-linked files.
 */
const realDestination = async (absolute: string): Promise<{ real: string; existed: boolean } | undefined> => {
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      await lstat(current);
    } catch (error) {
      const parent = dirname(current);
      if (!isMissing(error) || parent === current) return undefined;
      tail.unshift(basename(current));
      current = parent;
      continue;
    }
    try {
      const real = await realpath(current);
      const info = await stat(real);
      if (tail.length === 0) return info.isFile() && info.nlink === 1 ? { real, existed: true } : undefined;
      return info.isDirectory() ? { real: join(real, ...tail), existed: false } : undefined;
    } catch {
      return undefined;
    }
  }
};

/**
 * Whether every target lies beneath one of `roots`, both as spelled (resolved against `cwd`) and
 * after following links. Roots are absolute, normalized directories; a missing root matches nothing.
 */
export const withinRoots = async (targets: PathTargets, roots: readonly string[], cwd: string): Promise<boolean> => {
  const realRoots: (readonly [string, string])[] = [];
  for (const root of roots) {
    try {
      realRoots.push([root, await realpath(root)]);
    } catch {
      // A root that does not exist yet grants nothing.
    }
  }
  if (realRoots.length === 0) return false;
  for (const target of targets.paths) {
    if (!isPlainPath(target)) return false;
    const absolute = resolve(cwd, target);
    const destination = await realDestination(absolute);
    if (destination === undefined) return false;
    if (targets.recoversMissingRelative && !destination.existed && !isAbsolute(target)) return false;
    if (!realRoots.some(([root, real]) => beneath(root, absolute) && beneath(real, destination.real))) return false;
  }
  return true;
};
