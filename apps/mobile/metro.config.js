// Expo Metro config. The default resolver ignores the `exports` field, so
// workspace subpath imports like `@patch/wire/jobs` (a valid export in
// packages/wire/package.json) fail to bundle even though tsc/vitest/vite
// resolve them fine. Enable package-exports resolution so those subpaths work.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
