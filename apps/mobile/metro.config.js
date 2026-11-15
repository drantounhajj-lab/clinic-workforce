// Lets the app use the shared packages in ../../packages (rules, time clock)
// without publishing them. The mobile app keeps its own node_modules.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [path.join(repoRoot, "packages")];
config.resolver.nodeModulesPaths = [path.join(projectRoot, "node_modules")];
config.resolver.extraNodeModules = {
  "@clinic-workforce/rules": path.join(repoRoot, "packages/rules/src"),
  "@clinic-workforce/timeclock": path.join(repoRoot, "packages/timeclock/src"),
};

module.exports = config;
