import path from "path";
import { Context } from "../../bundler/context.js";
import { Config } from "./config.js";

export async function handleDebugBundlePath(
  ctx: Context,
  debugBundleDir: string,
  config: Config,
) {
  if (!await ctx.fs.exists(debugBundleDir)) {
    await ctx.fs.mkdir(debugBundleDir);
  } else if (!(await ctx.fs.stat(debugBundleDir)).isDirectory()) {
    return await ctx.crash({
      exitCode: 1,
      errorType: "fatal",
      printedMessage: `Path \`${debugBundleDir}\` is not a directory. Please choose an empty directory for \`--debug-bundle-path\`.`,
    });
  } else if ((await ctx.fs.listDir(debugBundleDir)).length !== 0) {
    await ctx.crash({
      exitCode: 1,
      errorType: "fatal",
      printedMessage: `Directory \`${debugBundleDir}\` is not empty. Please remove it or choose an empty directory for \`--debug-bundle-path\`.`,
    });
  }
  await ctx.fs.writeUtf8File(
    path.join(debugBundleDir, "fullConfig.json"),
    JSON.stringify(config),
  );

  for (const moduleInfo of config.modules) {
    const trimmedPath = moduleInfo.path.endsWith(".js")
      ? moduleInfo.path.slice(0, moduleInfo.path.length - ".js".length)
      : moduleInfo.path;
    const environmentDir = path.join(debugBundleDir, moduleInfo.environment);
    await ctx.fs.mkdir(path.dirname(path.join(environmentDir, `${trimmedPath}.js`)), {
      allowExisting: true,
      recursive: true,
    });
    await ctx.fs.writeUtf8File(
      path.join(environmentDir, `${trimmedPath}.js`),
      moduleInfo.source,
    );
    if (moduleInfo.sourceMap !== undefined) {
      await ctx.fs.writeUtf8File(
        path.join(environmentDir, `${trimmedPath}.js.map`),
        moduleInfo.sourceMap,
      );
    }
  }
}
