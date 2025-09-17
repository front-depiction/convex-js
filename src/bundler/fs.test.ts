import { test, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { nodeFs, asyncNodeFs, RecordingFs, AsyncRecordingFs, withTmpDir, stMatches, consistentPathSort } from "./fs.js";
import { Dirent } from "fs";

test("nodeFs filesystem operations behave as expected", async () => {
  const tmpdir = fs.mkdtempSync(`${os.tmpdir()}${path.sep}`);
  try {
    const parentDirPath = path.join(tmpdir, "testdir");
    const dirPath = path.join(parentDirPath, "nestedDir");
    const filePath = path.join(dirPath, "text.txt");

    // Test making and listing directories.
    try {
      nodeFs.mkdir(dirPath);
      throw new Error(
        "Expected `mkdir` to fail because the containing directory doesn't exist yet.",
      );
    } catch (e: any) {
      expect(e.code).toEqual("ENOENT");
    }

    nodeFs.mkdir(parentDirPath);
    nodeFs.mkdir(dirPath);
    try {
      nodeFs.mkdir(dirPath);
      throw new Error("Expected `mkdir` to fail without allowExisting");
    } catch (e: any) {
      expect(e.code).toEqual("EEXIST");
    }
    nodeFs.mkdir(dirPath, { allowExisting: true });

    const dirEntries = nodeFs.listDir(parentDirPath);
    expect(dirEntries).toHaveLength(1);
    expect(dirEntries[0].name).toEqual("nestedDir");

    const nestedEntries = nodeFs.listDir(dirPath);
    expect(nestedEntries).toHaveLength(0);

    // Test file based methods for nonexistent paths.
    expect(nodeFs.exists(filePath)).toEqual(false);
    try {
      nodeFs.stat(filePath);
      throw new Error("Expected `stat` to fail for nonexistent paths");
    } catch (e: any) {
      expect(e.code).toEqual("ENOENT");
    }
    try {
      nodeFs.readUtf8File(filePath);
      throw new Error("Expected `readUtf8File` to fail for nonexistent paths");
    } catch (e: any) {
      expect(e.code).toEqual("ENOENT");
    }
    try {
      nodeFs.access(filePath);
      throw new Error("Expected `access` to fail for nonexistent paths");
    } catch (e: any) {
      expect(e.code).toEqual("ENOENT");
    }

    // Test creating a file and accessing it.
    const message = "it's trompo o'clock";
    nodeFs.writeUtf8File(filePath, message);
    expect(nodeFs.exists(filePath)).toEqual(true);
    nodeFs.stat(filePath);
    expect(nodeFs.readUtf8File(filePath)).toEqual(message);
    nodeFs.access(filePath);

    // Test unlinking a file and directory.
    try {
      nodeFs.unlink(dirPath);
      throw new Error("Expected `unlink` to fail on a directory");
    } catch (e: any) {
      if (os.platform() === "linux") {
        expect(e.code).toEqual("EISDIR");
      } else {
        expect(e.code).toEqual("EPERM");
      }
    }
    nodeFs.unlink(filePath);
    expect(nodeFs.exists(filePath)).toEqual(false);
  } finally {
    fs.rmSync(tmpdir, { recursive: true });
  }
});

test("asyncNodeFs filesystem operations behave as expected", async () => {
  const tmpdir = fs.mkdtempSync(`${os.tmpdir()}${path.sep}`);
  try {
    const parentDirPath = path.join(tmpdir, "testdir");
    const dirPath = path.join(parentDirPath, "nestedDir");
    const filePath = path.join(dirPath, "text.txt");

    // Test making and listing directories.
    try {
      await asyncNodeFs.mkdir(dirPath);
      throw new Error(
        "Expected `mkdir` to fail because the containing directory doesn't exist yet.",
      );
    } catch (e: any) {
      expect(e.code).toEqual("ENOENT");
    }

    await asyncNodeFs.mkdir(parentDirPath);
    await asyncNodeFs.mkdir(dirPath);
    try {
      await asyncNodeFs.mkdir(dirPath);
      throw new Error("Expected `mkdir` to fail without allowExisting");
    } catch (e: any) {
      expect(e.code).toEqual("EEXIST");
    }
    await asyncNodeFs.mkdir(dirPath, { allowExisting: true });

    const dirEntries = await asyncNodeFs.listDir(parentDirPath);
    expect(dirEntries).toHaveLength(1);
    expect(dirEntries[0].name).toEqual("nestedDir");

    const nestedEntries = await asyncNodeFs.listDir(dirPath);
    expect(nestedEntries).toHaveLength(0);

    // Test file based methods for nonexistent paths.
    expect(await asyncNodeFs.exists(filePath)).toEqual(false);
    try {
      await asyncNodeFs.stat(filePath);
      throw new Error("Expected `stat` to fail for nonexistent paths");
    } catch (e: any) {
      expect(e.code).toEqual("ENOENT");
    }
    try {
      await asyncNodeFs.readUtf8File(filePath);
      throw new Error("Expected `readUtf8File` to fail for nonexistent paths");
    } catch (e: any) {
      expect(e.code).toEqual("ENOENT");
    }
    try {
      await asyncNodeFs.access(filePath);
      throw new Error("Expected `access` to fail for nonexistent paths");
    } catch (e: any) {
      expect(e.code).toEqual("ENOENT");
    }

    // Test creating a file and accessing it.
    const message = "it's trompo o'clock";
    await asyncNodeFs.writeUtf8File(filePath, message);
    expect(await asyncNodeFs.exists(filePath)).toEqual(true);
    await asyncNodeFs.stat(filePath);
    expect(await asyncNodeFs.readUtf8File(filePath)).toEqual(message);
    await asyncNodeFs.access(filePath);

    // Test swapTmpFile
    const tmpFile = path.join(tmpdir, "temp.txt") as any;
    const targetFile = path.join(dirPath, "target.txt");
    await asyncNodeFs.writeUtf8File(tmpFile, "temp content");
    await asyncNodeFs.swapTmpFile(tmpFile, targetFile);
    expect(await asyncNodeFs.exists(targetFile)).toEqual(true);
    expect(await asyncNodeFs.readUtf8File(targetFile)).toEqual("temp content");

    // Test unlinking a file and directory.
    try {
      await asyncNodeFs.unlink(dirPath);
      throw new Error("Expected `unlink` to fail on a directory");
    } catch (e: any) {
      if (os.platform() === "linux") {
        expect(e.code).toEqual("EISDIR");
      } else {
        expect(e.code).toEqual("EPERM");
      }
    }
    await asyncNodeFs.unlink(filePath);
    expect(await asyncNodeFs.exists(filePath)).toEqual(false);

    // Test rmdir - need to remove target.txt first
    await asyncNodeFs.unlink(targetFile);
    await asyncNodeFs.rmdir(dirPath);
    expect(await asyncNodeFs.exists(dirPath)).toEqual(false);
  } finally {
    fs.rmSync(tmpdir, { recursive: true });
  }
});

test("RecordingFs tracks file operations and detects changes", async () => {
  const tmpdir = fs.mkdtempSync(`${os.tmpdir()}${path.sep}`);
  try {
    const testFile = path.join(tmpdir, "test.txt");
    const testDir = path.join(tmpdir, "testdir");

    // Test recording reads
    const recorder = new RecordingFs(false);
    fs.writeFileSync(testFile, "initial content");
    fs.mkdirSync(testDir);
    fs.writeFileSync(path.join(testDir, "nested.txt"), "nested content");

    // Record some operations
    expect(recorder.exists(testFile)).toBe(true);
    expect(recorder.readUtf8File(testFile)).toBe("initial content");
    recorder.listDir(testDir);

    // Should not be invalidated yet
    const observations = recorder.finalize();
    expect(observations).not.toBe("invalidated");

    // Test invalidation on change
    const recorder2 = new RecordingFs(false);
    recorder2.readUtf8File(testFile);
    fs.writeFileSync(testFile, "modified content");
    recorder2.readUtf8File(testFile); // Reading again should detect the change
    expect(recorder2.finalize()).toBe("invalidated");

    // Test directory operations
    const recorder3 = new RecordingFs(false);
    const newFile = path.join(tmpdir, "new.txt");
    recorder3.writeUtf8File(newFile, "new content");
    expect(recorder3.exists(newFile)).toBe(true);
    recorder3.unlink(newFile);
    expect(recorder3.exists(newFile)).toBe(false);

    const obs = recorder3.finalize();
    expect(obs).not.toBe("invalidated");
  } finally {
    fs.rmSync(tmpdir, { recursive: true });
  }
});

test("AsyncRecordingFs tracks async operations", async () => {
  const tmpdir = fs.mkdtempSync(`${os.tmpdir()}${path.sep}`);
  try {
    const testFile = path.join(tmpdir, "test.txt");
    const testDir = path.join(tmpdir, "testdir");

    // Setup test files
    fs.writeFileSync(testFile, "initial content");
    fs.mkdirSync(testDir);
    fs.writeFileSync(path.join(testDir, "nested.txt"), "nested content");

    // Test async recording
    const recorder = new AsyncRecordingFs(false);
    expect(await recorder.exists(testFile)).toBe(true);
    expect(await recorder.readUtf8File(testFile)).toBe("initial content");
    await recorder.listDir(testDir);

    // Should not be invalidated
    const observations = recorder.finalize();
    expect(observations).not.toBe("invalidated");

    // Test async write operations
    const recorder2 = new AsyncRecordingFs(false);
    const newFile = path.join(tmpdir, "async-new.txt");
    await recorder2.writeUtf8File(newFile, "async content");
    expect(await recorder2.exists(newFile)).toBe(true);
    expect(await recorder2.readUtf8File(newFile)).toBe("async content");

    // Test directory creation
    const newDir = path.join(tmpdir, "async-dir");
    await recorder2.mkdir(newDir);
    expect(await recorder2.exists(newDir)).toBe(true);

    // Test file deletion
    await recorder2.unlink(newFile);
    expect(await recorder2.exists(newFile)).toBe(false);

    const obs2 = recorder2.finalize();
    expect(obs2).not.toBe("invalidated");
  } finally {
    fs.rmSync(tmpdir, { recursive: true });
  }
});

test("withTmpDir provides temporary directory", async () => {
  let tmpPath: string | undefined;
  let fileCreated = false;

  await withTmpDir(async (tmpDir) => {
    tmpPath = tmpDir.path;
    expect(fs.existsSync(tmpPath)).toBe(true);

    // Test writeUtf8File
    const tempFile = tmpDir.writeUtf8File("temp content");
    expect(fs.existsSync(tempFile)).toBe(true);
    expect(fs.readFileSync(tempFile, "utf-8")).toBe("temp content");

    // Test registerTempPath
    const stat = fs.statSync(tempFile);
    const registeredPath = tmpDir.registerTempPath(stat);
    expect(registeredPath).toBeTruthy();

    fileCreated = true;
  });

  // Temp directory should be cleaned up
  expect(fileCreated).toBe(true);
  if (tmpPath) {
    expect(fs.existsSync(tmpPath)).toBe(false);
  }
});

test("stMatches compares file stats correctly", () => {
  const tmpdir = fs.mkdtempSync(`${os.tmpdir()}${path.sep}`);
  try {
    const file1 = path.join(tmpdir, "file1.txt");
    const file2 = path.join(tmpdir, "file2.txt");
    const dir1 = path.join(tmpdir, "dir1");

    fs.writeFileSync(file1, "content1");
    fs.writeFileSync(file2, "content2");
    fs.mkdirSync(dir1);

    const stat1 = fs.statSync(file1);
    const stat2 = fs.statSync(file2);
    const dirStat = fs.statSync(dir1);

    // Same file should match
    const match1 = stMatches(stat1, stat1);
    expect(match1.matches).toBe(true);

    // Different files should not match
    const match2 = stMatches(stat1, stat2);
    expect(match2.matches).toBe(false);
    if (!match2.matches) {
      expect(match2.reason).toContain("inode");
    }

    // File vs directory should not match
    const match3 = stMatches(stat1, dirStat);
    expect(match3.matches).toBe(false);
    if (!match3.matches) {
      expect(match3.reason).toContain("file type");
    }

    // Null comparisons
    expect(stMatches(null, null).matches).toBe(true);
    expect(stMatches(stat1, null).matches).toBe(false);
    expect(stMatches(null, stat1).matches).toBe(false);
  } finally {
    fs.rmSync(tmpdir, { recursive: true });
  }
});

test("consistentPathSort sorts directory entries correctly", () => {
  const entries: Dirent[] = [
    { name: "z.txt", isFile: () => true } as Dirent,
    { name: "a.txt", isFile: () => true } as Dirent,
    { name: "ab.txt", isFile: () => true } as Dirent,
    { name: "aa.txt", isFile: () => true } as Dirent,
  ];

  entries.sort(consistentPathSort);

  expect(entries.map(e => e.name)).toEqual([
    "a.txt",
    "aa.txt",
    "ab.txt",
    "z.txt",
  ]);
});

test("RecordingFs detects directory changes", () => {
  const tmpdir = fs.mkdtempSync(`${os.tmpdir()}${path.sep}`);
  try {
    const testDir = path.join(tmpdir, "testdir");
    fs.mkdirSync(testDir);

    // Create initial state with a file
    const existingFile = path.join(testDir, "existing.txt");
    fs.writeFileSync(existingFile, "initial");

    // Record initial state
    const recorder1 = new RecordingFs(false);
    recorder1.listDir(testDir);
    const obs1 = recorder1.finalize();
    expect(obs1).not.toBe("invalidated");

    // Add a new file to the directory
    const newFile = path.join(testDir, "new.txt");
    fs.writeFileSync(newFile, "content");

    // Record with same observations, then detect change
    const recorder2 = new RecordingFs(false);
    // First listDir records the directory with one file
    recorder2.listDir(testDir);
    // Delete the new file to change the directory
    fs.unlinkSync(newFile);
    // Second listDir should detect the change
    recorder2.listDir(testDir);
    const obs2 = recorder2.finalize();
    expect(obs2).toBe("invalidated");
  } finally {
    fs.rmSync(tmpdir, { recursive: true });
  }
});

test("AsyncNodeFs handles recursive directory creation", async () => {
  const tmpdir = fs.mkdtempSync(`${os.tmpdir()}${path.sep}`);
  try {
    const deepPath = path.join(tmpdir, "a", "b", "c", "d");

    // Should create all intermediate directories
    await asyncNodeFs.mkdir(deepPath, { recursive: true });
    expect(await asyncNodeFs.exists(deepPath)).toBe(true);

    // Should not fail if already exists with allowExisting
    await asyncNodeFs.mkdir(deepPath, { allowExisting: true });
    expect(await asyncNodeFs.exists(deepPath)).toBe(true);
  } finally {
    fs.rmSync(tmpdir, { recursive: true });
  }
});

test("createReadStream works for both sync and async fs", async () => {
  const tmpdir = fs.mkdtempSync(`${os.tmpdir()}${path.sep}`);
  try {
    const testFile = path.join(tmpdir, "stream-test.txt");
    const content = "This is test content for streaming";
    fs.writeFileSync(testFile, content);

    // Test sync version
    const stream1 = nodeFs.createReadStream(testFile, {});
    let readContent1 = "";
    for await (const chunk of stream1) {
      readContent1 += chunk.toString();
    }
    expect(readContent1).toBe(content);

    // Test async version
    const stream2 = asyncNodeFs.createReadStream(testFile, {});
    let readContent2 = "";
    for await (const chunk of stream2) {
      readContent2 += chunk.toString();
    }
    expect(readContent2).toBe(content);
  } finally {
    fs.rmSync(tmpdir, { recursive: true });
  }
});
