import path from "path";
import chalk from "chalk";
import esbuild from "esbuild";
import { parse as parseAST } from "@babel/parser";
import { Identifier, ImportSpecifier } from "@babel/types";
import * as Sentry from "@sentry/node";
import { AsyncFilesystem, consistentPathSort } from "./fs.js";
import { Context } from "./context.js";
import { logVerbose, logWarning } from "./log.js";
import { wasmPlugin } from "./wasm.js";
import {
  ExternalPackage,
  computeExternalPackages,
  createExternalPlugin,
  findExactVersionAndDependencies,
} from "./external.js";
import { innerEsbuild, isEsbuildBuildError } from "./debugBundle.js";
import ignore from "ignore";
export { nodeFs, RecordingFs } from "./fs.js";
export type { Filesystem } from "./fs.js";

export const actionsDir = "actions";

// Returns a generator of { isDir, path, depth } for all paths
// within dirPath in some topological order (not including
// dirPath itself).
export async function* walkDir(
  fs: AsyncFilesystem,
  dirPath: string,
  depth?: number,
): AsyncGenerator<{ isDir: boolean; path: string; depth: number }, void, void> {
  depth = depth ?? 0;
  const entries = await fs.listDir(dirPath);
  for (const dirEntry of entries.sort(consistentPathSort)) {
    const childPath = path.join(dirPath, dirEntry.name);
    if (dirEntry.isDirectory()) {
      yield { isDir: true, path: childPath, depth };
      yield* walkDir(fs, childPath, depth + 1);
    } else if (dirEntry.isFile()) {
      yield { isDir: false, path: childPath, depth };
    }
  }
}

// Convex specific module environment.
type ModuleEnvironment = "node" | "isolate";

export interface Bundle {
  path: string;
  source: string;
  sourceMap?: string | undefined;
  environment: ModuleEnvironment;
}

export interface BundleHash {
  path: string;
  hash: string;
  environment: ModuleEnvironment;
}

type EsBuildResult = esbuild.BuildResult & {
  outputFiles: esbuild.OutputFile[];
  // Set of referenced external modules.
  externalModuleNames: Set<string>;
  // Set of bundled modules.
  bundledModuleNames: Set<string>;
};

function analyzeEsbuildError(
  ctx: Context,
  error: unknown,
  platform: esbuild.Platform,
): string | null {
  if (!isEsbuildBuildError(error)) return null;

  let recommendUseNode = false;

  for (const err of error.errors) {
    if (err.location) {
      const absPath = path.resolve(err.location.file);
      // Note: We can't use async here as this is called from catch block
      // Just register the path without stat for now
      ctx.fs.registerPath(absPath, null);
    }

    const hasNodeHint = platform !== "node" &&
      err.notes.some(note => note.text.includes("Are you trying to bundle for node?"));

    if (hasNodeHint) recommendUseNode = true;
  }

  if (!recommendUseNode) return null;

  return [
    `\nIt looks like you are using Node APIs from a file without the "use node" directive.`,
    `Split out actions using Node.js APIs like this into a new file only containing actions that uses "use node" `,
    `so these actions will run in a Node.js environment.`,
    `For more information see https://docs.convex.dev/functions/runtimes#nodejs-runtime\n`
  ].join('\n');
}

async function doEsbuild(
  ctx: Context,
  dir: string,
  entryPoints: string[],
  generateSourceMaps: boolean,
  platform: esbuild.Platform,
  chunksFolder: string,
  externalPackages: Map<string, ExternalPackage>,
  extraConditions: string[],
): Promise<EsBuildResult> {
  const external = createExternalPlugin(ctx, externalPackages);
  try {
    const result = await innerEsbuild({
      entryPoints,
      platform,
      generateSourceMaps,
      chunksFolder,
      extraConditions,
      dir,
      // The wasmPlugin should be last so it doesn't run on external modules.
      plugins: [external.plugin, wasmPlugin],
    });

    for (const [relPath, input] of Object.entries(result.metafile!.inputs)) {
      // TODO: esbuild outputs paths prefixed with "(disabled)"" when bundling our internal
      // udf-runtime package. The files do actually exist locally, though.
      if (
        relPath.indexOf("(disabled):") !== -1 ||
        relPath.startsWith("wasm-binary:") ||
        relPath.startsWith("wasm-stub:")
      ) {
        continue;
      }
      const absPath = path.resolve(relPath);
      try {
        const st = await ctx.fs.stat(absPath);
        if (st.size !== input.bytes) {
          logWarning(
            `Bundled file ${absPath} changed right after esbuild invocation`,
          );
          // Consider this a transient error so we'll try again and hopefully
          // no files change right after esbuild next time.
          return await ctx.crash({
            exitCode: 1,
            errorType: "transient",
            printedMessage: null,
          });
        }
        ctx.fs.registerPath(absPath, st);
      } catch {
        // File might have been deleted, ignore
      }
    }
    return {
      ...result,
      externalModuleNames: external.externalModuleNames,
      bundledModuleNames: external.bundledModuleNames,
    };
  } catch (e: unknown) {
    const message = analyzeEsbuildError(ctx, e, platform);
    return await ctx.crash({
      exitCode: 1,
      errorType: "invalid filesystem data",
      printedMessage: message,
    });
  }
}

export async function bundle(
  ctx: Context,
  dir: string,
  entryPoints: string[],
  generateSourceMaps: boolean,
  platform: esbuild.Platform,
  chunksFolder = "_deps",
  externalPackagesAllowList: string[] = [],
  extraConditions: string[] = [],
): Promise<{
  modules: Bundle[];
  externalDependencies: Map<string, string>;
  bundledModuleNames: Set<string>;
}> {
  const availableExternalPackages = await computeExternalPackages(
    ctx,
    externalPackagesAllowList,
  );
  const result = await doEsbuild(
    ctx,
    dir,
    entryPoints,
    generateSourceMaps,
    platform,
    chunksFolder,
    availableExternalPackages,
    extraConditions,
  );
  // Some ESBuild errors won't show up here, instead crashing in doEsbuild().
  if (result.errors.length) {
    const errorMessage = result.errors
      .map((e) => `esbuild error: ${e.text}`)
      .join("\n");
    return await ctx.crash({
      exitCode: 1,
      errorType: "invalid filesystem data",
      printedMessage: errorMessage,
    });
  }
  for (const warning of result.warnings) {
    logWarning(chalk.yellow(`esbuild warning: ${warning.text}`));
  }
  const sourceMaps = new Map();
  const modules: Bundle[] = [];
  const environment = platform === "node" ? "node" : "isolate";
  for (const outputFile of result.outputFiles) {
    const relPath = path.relative(path.normalize("out"), outputFile.path);
    if (path.extname(relPath) === ".map") {
      sourceMaps.set(relPath, outputFile.text);
      continue;
    }
    const posixRelPath = relPath.split(path.sep).join(path.posix.sep);
    modules.push({ path: posixRelPath, source: outputFile.text, environment });
  }
  for (const module of modules) {
    const sourceMapPath = module.path + ".map";
    const sourceMap = sourceMaps.get(sourceMapPath);
    if (sourceMap) {
      module.sourceMap = sourceMap;
    }
  }

  return {
    modules,
    externalDependencies: await externalPackageVersions(
      ctx,
      availableExternalPackages,
      result.externalModuleNames,
    ),
    bundledModuleNames: result.bundledModuleNames,
  };
}

// We could return the full list of availableExternalPackages, but this would be
// installing more packages that we need. Instead, we collect all external
// dependencies we found during bundling the /convex function, as well as their
// respective peer and optional dependencies.
async function externalPackageVersions(
  ctx: Context,
  availableExternalPackages: Map<string, ExternalPackage>,
  referencedPackages: Set<string>,
): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  const referencedPackagesQueue = Array.from(referencedPackages.keys());

  for (let i = 0; i < referencedPackagesQueue.length; i++) {
    const moduleName = referencedPackagesQueue[i];
    // This assertion is safe because referencedPackages can only contain
    // packages in availableExternalPackages.
    const modulePath = availableExternalPackages.get(moduleName)!.path;
    // Since we don't support lock files and different install commands yet, we
    // pick up the exact version installed on the local filesystem.
    const { version, peerAndOptionalDependencies } =
      await findExactVersionAndDependencies(ctx, moduleName, modulePath);
    versions.set(moduleName, version);

    for (const dependency of peerAndOptionalDependencies) {
      if (
        availableExternalPackages.has(dependency) &&
        !referencedPackages.has(dependency)
      ) {
        referencedPackagesQueue.push(dependency);
        referencedPackages.add(dependency);
      }
    }
  }

  return versions;
}

export async function bundleSchema(
  ctx: Context,
  dir: string,
  extraConditions: string[],
) {
  const target = await resolveSchemaFile(ctx, dir);
  const result = await bundle(
    ctx,
    dir,
    [target],
    true,
    "browser",
    undefined,
    extraConditions,
  );
  return result.modules;
}

async function resolveSchemaFile(ctx: Context, dir: string): Promise<string> {
  const tsPath = path.resolve(dir, "schema.ts");
  const jsPath = path.resolve(dir, "schema.js");

  const tsExists = await ctx.fs.exists(tsPath);
  return tsExists ? tsPath : jsPath;
}

type AuthConfigResult =
  | { type: "none" }
  | { type: "found"; path: string }
  | { type: "conflict"; jsPath: string; tsPath: string };

async function findAuthConfig(ctx: Context, dir: string): Promise<AuthConfigResult> {
  const jsPath = path.resolve(dir, "auth.config.js");
  const tsPath = path.resolve(dir, "auth.config.ts");

  const [jsExists, tsExists] = await Promise.all([
    ctx.fs.exists(jsPath),
    ctx.fs.exists(tsPath),
  ]);

  if (jsExists && tsExists) {
    return { type: "conflict", jsPath, tsPath };
  }

  if (tsExists) return { type: "found", path: tsPath };
  if (jsExists) return { type: "found", path: jsPath };

  return { type: "none" };
}

export async function bundleAuthConfig(ctx: Context, dir: string) {
  const authConfig = await findAuthConfig(ctx, dir);

  switch (authConfig.type) {
    case "conflict":
      return await ctx.crash({
        exitCode: 1,
        errorType: "invalid filesystem data",
        printedMessage: `Found both ${authConfig.jsPath} and ${authConfig.tsPath}, choose one.`,
      });

    case "none":
      logVerbose(
        chalk.yellow(
          `Found no auth config file at ${path.resolve(dir, "auth.config.ts")} or ${path.resolve(dir, "auth.config.js")} so there are no configured auth providers`,
        ),
      );
      return [];

    case "found": {
      logVerbose(chalk.yellow(`Bundling auth config found at ${authConfig.path}`));
      const result = await bundle(ctx, dir, [authConfig.path], true, "browser");
      return result.modules;
    }
  }
}

export async function doesImportConvexHttpRouter(source: string) {
  try {
    const ast = parseAST(source, {
      sourceType: "module",
      plugins: ["typescript"],
    });
    return ast.program.body.some((node) => {
      if (node.type !== "ImportDeclaration") return false;
      return node.specifiers.some((s) => {
        const specifier = s as ImportSpecifier;
        const imported = specifier.imported as Identifier;
        return imported.name === "httpRouter";
      });
    });
  } catch {
    return (
      source.match(
        /import\s*\{\s*httpRouter.*\}\s*from\s*"\s*convex\/server\s*"/,
      ) !== null
    );
  }
}

export async function loadConvexIgnore(ctx: Context, projectRoot: string) {
  const ig = ignore();
  const paths = [
    path.join(projectRoot, ".convexignore"),
    path.join(projectRoot, "convex", ".convexignore"),
  ];

  const found = await Promise.all(
    paths.map(async p => {
      const exists = await ctx.fs.exists(p);
      return {
        path: p,
        exists,
        content: exists ? await ctx.fs.readUtf8File(p) : null
      };
    })
  );

  const existing = found.filter(f => f.exists);

  if (existing.length > 1) {
    return ctx.crash({
      exitCode: 1,
      errorType: "invalid filesystem data",
      printedMessage: `Multiple .convexignore files found: ${existing.map(f => f.path).join(', ')}. Please use only one.`
    });
  }

  if (existing.length === 1) {
    logVerbose(chalk.green(`Loading .convexignore from ${existing[0].path}`));
    ig.add(existing[0].content!);
  } else {
    logVerbose(chalk.gray("No .convexignore file found, all files will be processed"));
  }

  return ig;
}

const ENTRY_POINT_EXTENSIONS = [
  // ESBuild js loader
  ".js",
  ".mjs",
  ".cjs",
  // ESBuild ts loader
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  // ESBuild jsx loader
  ".jsx",
  // ESBuild supports css, text, json, and more but these file types are not
  // allowed to define entry points.
];

type FileFilterResult =
  | { type: "include" }
  | { type: "skip"; reason: string }
  | { type: "error"; message: string };

function evaluateFileFilter(
  relPath: string,
  base: string,
  fpath: string,
): FileFilterResult {
  // Reserved directories - these cause errors
  if (relPath.startsWith("_deps" + path.sep)) {
    return {
      type: "error",
      message: `The path "${fpath}" is within the "_deps" directory, which is reserved for dependencies. Please move your code to another directory.`,
    };
  }

  // Check file extension
  const hasValidExtension = ENTRY_POINT_EXTENSIONS.some(ext => relPath.endsWith(ext));
  if (!hasValidExtension) {
    return { type: "skip", reason: `Skipping non-JS file ${fpath}` };
  }

  // Skip patterns with reasons
  const skipChecks: Array<[() => boolean, string]> = [
    [() => relPath.startsWith("_generated" + path.sep), `Skipping ${fpath}`],
    [() => base.startsWith("."), `Skipping dotfile ${fpath}`],
    [() => base.startsWith("#"), `Skipping likely emacs tempfile ${fpath}`],
    [() => base === "schema.ts" || base === "schema.js", `Skipping ${fpath}`],
    [() => (base.match(/\./g) || []).length > 1, `Skipping ${fpath} that contains multiple dots`],
    [() => relPath.includes(" "), `Skipping ${relPath} because it contains a space`],
  ];

  for (const [check, reason] of skipChecks) {
    if (check()) return { type: "skip", reason };
  }

  return { type: "include" };
}

export async function entryPoints(
  ctx: Context,
  dir: string,
): Promise<string[]> {
  const entryPoints = [];
  const projectRoot = path.dirname(dir);
  const ig = await loadConvexIgnore(ctx, projectRoot);

  for await (const { isDir, path: fpath, depth } of walkDir(ctx.fs, dir)) {
    if (isDir) continue;

    const relPath = path.relative(dir, fpath);

    // Check .convexignore
    if (ig.ignores(relPath)) {
      logVerbose(chalk.yellow(`Skipping ignored file ${fpath}`));
      continue;
    }

    const parsedPath = path.parse(fpath);
    const base = parsedPath.base;
    const extension = parsedPath.ext.toLowerCase();

    // Evaluate if file should be processed
    const filterResult = evaluateFileFilter(relPath, base, fpath);

    switch (filterResult.type) {
      case "error":
        return await ctx.crash({
          exitCode: 1,
          errorType: "invalid filesystem data",
          printedMessage: filterResult.message,
        });

      case "skip":
        logVerbose(chalk.yellow(filterResult.reason));
        continue;

      case "include":
        // Check for misnamed HTTP files at root level
        if (depth === 0 && base.toLowerCase().startsWith("https.")) {
          const source = await ctx.fs.readUtf8File(fpath);
          if (await doesImportConvexHttpRouter(source)) {
            logWarning(
              chalk.yellow(
                `Found ${fpath}. HTTP action routes will not be imported from this file. Did you mean to include http${extension}?`,
              ),
            );
            Sentry.captureMessage(
              `User code top level directory contains file ${base} which imports httpRouter.`,
              "warning",
            );
          }
        }

        logVerbose(chalk.green(`Preparing ${fpath}`));
        entryPoints.push(fpath);
        break;
    }
  }

  // If using TypeScript, require that at least one line starts with `export` or `import`,
  // a TypeScript requirement. This prevents confusing type errors from empty .ts files.
  const checks = await Promise.all(
    entryPoints.map(async (fpath) => {
      // This check only makes sense for TypeScript files
      if (!fpath.endsWith(".ts") && !fpath.endsWith(".tsx")) {
        return { fpath, valid: true };
      }
      const contents = await ctx.fs.readUtf8File(fpath);
      const valid = /^\s{0,100}(import|export)/m.test(contents);
      if (!valid) {
        logVerbose(
          chalk.yellow(
            `Skipping ${fpath} because it has no export or import to make it a valid TypeScript module`,
          ),
        );
      }
      return { fpath, valid };
    })
  );
  const nonEmptyEntryPoints = checks.filter(c => c.valid).map(c => c.fpath);

  return nonEmptyEntryPoints;
}

// A fallback regex in case we fail to parse the AST.
export const useNodeDirectiveRegex = /^\s*("|')use node("|');?\s*$/;

async function hasUseNodeDirective(ctx: Context, fpath: string): Promise<boolean> {
  // Do a quick check for the exact string. If it doesn't exist, don't
  // bother parsing.
  const source = await ctx.fs.readUtf8File(fpath);
  if (source.indexOf("use node") === -1) {
    return false;
  }

  // We parse the AST here to extract the "use node" declaration. This is more
  // robust than doing a regex. We only use regex as a fallback.
  try {
    const ast = parseAST(source, {
      // parse in strict mode and allow module declarations
      sourceType: "module",

      // esbuild supports jsx and typescript by default. Allow the same plugins
      // here too.
      plugins: ["jsx", "typescript"],
    });
    return ast.program.directives
      .map((d) => d.value.value)
      .includes("use node");
  } catch (error: any) {
    // Given that we have failed to parse, we are most likely going to fail in
    // the esbuild step, which seem to return better formatted error messages.
    // We don't throw here and fallback to regex.
    let lineMatches = false;
    for (const line of source.split("\n")) {
      if (line.match(useNodeDirectiveRegex)) {
        lineMatches = true;
        break;
      }
    }

    // Log that we failed to parse in verbose node if we need this for debugging.
    logVerbose(
      `Failed to parse ${fpath}. Use node is set to ${lineMatches} based on regex. Parse error: ${error.toString()}.`,
    );

    return lineMatches;
  }
}

export function mustBeIsolate(relPath: string): boolean {
  // Check if the path without extension matches any of the static paths.
  return ["http", "crons", "schema", "auth.config"].includes(
    relPath.replace(/\.[^/.]+$/, ""),
  );
}

type EnvironmentDecision =
  | { type: "environment"; value: ModuleEnvironment }
  | { type: "error"; message: string };

function determineModuleEnvironment(
  relPath: string,
  useNodeDirective: boolean,
): EnvironmentDecision {
  // Case: "use node" directive present
  if (useNodeDirective) {
    if (mustBeIsolate(relPath)) {
      return {
        type: "error",
        message: `"use node" directive is not allowed for ${relPath}.`,
      };
    }
    return { type: "environment", value: "node" };
  }

  // Case: File in deprecated /actions folder without "use node"
  const actionsPrefix = actionsDir + path.sep;
  if (relPath.startsWith(actionsPrefix)) {
    return {
      type: "error",
      message: [
        `${relPath} is in /actions subfolder but has no "use node"; directive.`,
        `You can now define actions in any folder and indicate they should run in node by adding "use node" directive.`,
        `/actions is a deprecated way to choose Node.js environment, and we require "use node" for all files within that folder to avoid unexpected errors during the migration.`,
        `See https://docs.convex.dev/functions/actions for more details`,
      ].join(' '),
    };
  }

  // Default case
  return { type: "environment", value: "isolate" };
}

async function determineEnvironment(
  ctx: Context,
  dir: string,
  fpath: string,
): Promise<ModuleEnvironment> {
  const relPath = path.relative(dir, fpath);
  const useNodeDirective = await hasUseNodeDirective(ctx, fpath);
  const decision = determineModuleEnvironment(relPath, useNodeDirective);

  switch (decision.type) {
    case "error":
      return await ctx.crash({
        exitCode: 1,
        errorType: "invalid filesystem data",
        printedMessage: decision.message,
      });
    case "environment":
      return decision.value;
  }
}

export async function entryPointsByEnvironment(ctx: Context, dir: string) {
  const eps = await entryPoints(ctx, dir);
  const environments = await Promise.all(
    eps.map(ep => determineEnvironment(ctx, dir, ep))
  );
  const isolate = eps.filter((_, i) => environments[i] === "isolate");
  const node = eps.filter((_, i) => environments[i] === "node");
  return { isolate, node };
}
