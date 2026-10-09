// React Native autolinking config (consumed by expo-modules-autolinking's
// `react-native-config` resolver during `:app:generateAutolinkingPackageList`).
//
// WHY THIS EXISTS — the `expo` package's android Gradle module declares
// `namespace "expo.core"`, but the actual ReactPackage class lives at
// `expo.modules.ExpoModulesPackage`. The `expo` package ships its own
// `react-native.config.js` that corrects this via
// `packageImportPath: 'import expo.modules.ExpoModulesPackage;'`, but that
// file calls `findProjectRootSync()` which fails under this pnpm-symlinked
// monorepo layout, so the override is silently dropped and autolinking
// falls back to the `expo.core` namespace. The generated PackageList.java
// then imports the non-existent `expo.core.ExpoModulesPackage`, failing
// `:app:compileReleaseJavaWithJavac` with "cannot find symbol".
//
// The autolinking resolver merges `projectConfig.dependencies[name]` over
// each package's own config (reactNativeConfig.js → resolveDependencyConfig
// Async), so declaring the correct import path here deterministically wins.
// NO FALLBACK: this is an explicit, build-verified override, not a guess.

module.exports = {
  dependencies: {
    expo: {
      platforms: {
        android: {
          packageImportPath: 'import expo.modules.ExpoModulesPackage;',
          packageInstance: 'new ExpoModulesPackage()',
        },
      },
    },
  },
};
