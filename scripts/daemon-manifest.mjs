// Adding the Mac's host build to the manifest the box already published.
//
// The box builds linux-x64 and publishes daemon-latest.json; the darwin-arm64
// artifact can only be built on the Mac (codesigning), so it arrives second and
// is merged in. A Mac host reads the same manifest and looks for its own
// target, so a darwin entry from a DIFFERENT build than the one the manifest
// names would install code that says it is a version it is not. Hence every
// mismatch here is a refusal, never a best effort.

/**
 * @param {object} published  the manifest the box is serving
 * @param {object} built      the manifest the Mac's build wrote
 * @param {string} target     the target the Mac built
 * @returns {object} `published` with `target`'s artifact replaced by the Mac's
 */
export function mergeDaemonArtifact(published, built, target) {
  if (built.version !== published.version || built.gitSha !== published.gitSha) {
    throw new Error(
      `the Mac built ${built.version} (${built.gitSha}) but the box is serving ` +
        `${published.version} (${published.gitSha}) — refusing to mix two builds in one manifest`,
    );
  }
  if (built.signingPublicKey !== published.signingPublicKey) {
    throw new Error(
      `the Mac signed ${target} with a different artifact key from the box's — ` +
        'self-update would refuse it. Copy ~/.patch-daemon-build/artifact-signing.key from the box.',
    );
  }
  const artifact = built.artifacts?.find((a) => a.target === target);
  if (!artifact) throw new Error(`the Mac's build has no ${target} artifact`);
  return {
    ...published,
    artifacts: [...published.artifacts.filter((a) => a.target !== target), artifact],
  };
}
