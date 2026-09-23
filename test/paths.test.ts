import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { editTargets, withinRoots, writeTargets, type EditInspect, type PathTargets } from "../src/paths.ts";

describe("withinRoots", () => {
  let base: string;
  let root: string;
  let outside: string;
  before(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "auto-mode-paths-")));
    root = join(base, "scratch");
    outside = join(base, "outside");
    await mkdir(join(root, "sub"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(root, "sub", "existing.txt"), "x");
    await writeFile(join(outside, "secret.txt"), "x");
    await symlink(outside, join(root, "escape"));
    await symlink(join(outside, "secret.txt"), join(root, "secret-link.txt"));
    await symlink(join(root, "sub", "existing.txt"), join(root, "inner-link.txt"));
    await symlink(join(base, "missing"), join(root, "dangling"));
    await link(join(outside, "secret.txt"), join(root, "hard.txt"));
  });
  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const written = (...paths: string[]): PathTargets => ({ paths, recoversMissingRelative: false });
  const check = (targets: PathTargets, cwd = base) => withinRoots(targets, [root], cwd);

  it("allows existing and new files beneath the root, including relative spellings", async () => {
    assert.equal(await check(written(join(root, "sub", "existing.txt"))), true);
    assert.equal(await check(written(join(root, "new", "deeper", "file.txt"))), true);
    assert.equal(await check(written("sub/existing.txt", "./fresh.txt"), root), true);
    assert.equal(await check(written(join(root, "inner-link.txt"), join(root, "with space.txt"))), true);
  });

  it("requires every target to be beneath the root", async () => {
    assert.equal(await check(written(join(root, "a.txt"), join(outside, "b.txt"))), false);
    assert.equal(await check(written(root)), false);
    assert.equal(await check(written(`${root}-evil/x.txt`)), false);
  });

  it("refuses links, parent segments, and multiply-linked files that resolve elsewhere", async () => {
    for (const target of [
      join(root, "escape", "x.txt"),
      join(root, "escape", "secret.txt"),
      join(root, "secret-link.txt"),
      join(root, "dangling"),
      join(root, "dangling", "x.txt"),
      join(root, "hard.txt"),
      `${root}/sub/../x.txt`,
      join(root, "sub", "existing.txt", "x"),
    ]) {
      assert.equal(await check(written(target)), false, target);
    }
  });

  it("refuses spellings omp resolves specially", async () => {
    for (const target of [
      "~/x.txt",
      `@${root}/x.txt`,
      `local://${root}/x.txt`,
      `file://${root}/x.txt`,
      `${root}/data.zip:inner.txt`,
      `${root}/data.db?q=1`,
      `[${root}/x.txt#ABCD]`,
      `${root}/x\\y.txt`,
      `${root}/x\u00a0y.txt`,
      ` ${root}/x.txt`,
      "",
    ]) {
      assert.equal(await check(written(target)), false, target);
    }
  });

  it("refuses a missing relative edit target that could be recovered to another file", async () => {
    const edited = (...paths: string[]): PathTargets => ({ paths, recoversMissingRelative: true });
    assert.equal(await check(edited("sub/existing.txt"), root), true);
    assert.equal(await check(edited(join(root, "created.txt"))), true);
    assert.equal(await check(edited("created.txt"), root), false);
  });

  it("matches nothing when the root does not exist", async () => {
    assert.equal(await withinRoots(written(join(base, "absent", "x.txt")), [join(base, "absent")], base), false);
  });
});

describe("targets", () => {
  it("takes the write path and rejects a malformed write", () => {
    assert.deepEqual(writeTargets({ path: "a.txt", content: "x" })?.paths, ["a.txt"]);
    assert.equal(writeTargets({ content: "x" }), undefined);
  });

  it("unions every edit mode's targets, including move destinations", () => {
    const inspect: EditInspect = (mode) =>
      mode === "hashline"
        ? { paths: ["a.ts"], entries: [{ path: "a.ts" }], fileOps: [{ path: "b.ts", to: "/elsewhere/c.ts" }] }
        : mode === "apply_patch"
          ? { paths: ["d.ts"], entries: [], fileOps: [] }
          : { paths: [], entries: [], fileOps: [] };
    assert.deepEqual(editTargets({ input: "" }, inspect), {
      paths: ["d.ts", "a.ts", "b.ts", "/elsewhere/c.ts"],
      recoversMissingRelative: true,
    });
  });

  it("yields no targets when inspection finds none or fails", () => {
    assert.equal(editTargets({ input: "" }, () => ({ paths: [], entries: [], fileOps: [] })), undefined);
    const failing: EditInspect = (mode) => {
      if (mode === "sloppy") throw new Error("unparseable");
      return { paths: ["a.ts"], entries: [], fileOps: [] };
    };
    assert.equal(editTargets({ input: "" }, failing), undefined);
  });
});
