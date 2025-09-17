import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { oneoffContext, Context } from "../../bundler/context.js";
import fs from "fs";
import os from "os";
import path from "path";
import { recursivelyDelete } from "./fsUtils.js";

describe("fsUtils", async () => {
  let tmpDir: string;
  let ctx: Context;

  beforeEach(async () => {
    ctx = await oneoffContext({
      url: undefined,
      adminKey: undefined,
      envFile: undefined,
    });
    tmpDir = fs.mkdtempSync(`${os.tmpdir()}${path.sep}`);
  });

  describe("recursivelyDelete", () => {
    test("deletes file", async () => {
      const file = path.join(tmpDir, "file");
      await ctx.fs.writeUtf8File(file, "contents");
      expect(await ctx.fs.exists(file)).toBe(true);

      await recursivelyDelete(ctx, file);
      expect(await ctx.fs.exists(file)).toBe(false);
    });

    test("throws an error on non-existent file", async () => {
      const nonexistentFile = path.join(tmpDir, "nonexistent_file");
      await expect(
        recursivelyDelete(ctx, nonexistentFile)
      ).rejects.toThrow("ENOENT: no such file or directory");
    });

    test("does not throw error if `force` is used", async () => {
      const nonexistentFile = path.join(tmpDir, "nonexistent_file");
      await recursivelyDelete(ctx, nonexistentFile, { force: true });
    });

    test("recursively deletes a directory", async () => {
      const dir = path.join(tmpDir, "dir");
      await ctx.fs.mkdir(dir);
      const nestedFile = path.join(dir, "nested_file");
      await ctx.fs.writeUtf8File(nestedFile, "content");
      const nestedDir = path.join(dir, "nested_dir");
      await ctx.fs.mkdir(nestedDir);

      expect(await ctx.fs.exists(dir)).toBe(true);

      await recursivelyDelete(ctx, dir);
      expect(await ctx.fs.exists(dir)).toBe(false);
    });

    test("`recursive` and `force` work together", async () => {
      const nonexistentDir = path.join(tmpDir, "nonexistent_dir");
      // Shouldn't throw an exception.
      await recursivelyDelete(ctx, nonexistentDir, { force: true });
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });
});
