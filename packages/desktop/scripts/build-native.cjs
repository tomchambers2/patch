#!/usr/bin/env node
// Build the native audio helper (native/patch-audio) into build/native/patch-audio.
// macOS only: it is a Core Audio tap (14.4+). The packaged app carries it as
// Contents/Resources/bin/patch-audio (electron-builder.yml extraResources).
//
// NO FALLBACK: no Swift toolchain, or a compile error, stops the build here.
//
//   node scripts/build-native.cjs

const { execFileSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

const DESKTOP_DIR = path.resolve(__dirname, '..');

function buildNative({ desktopDir = DESKTOP_DIR } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('The audio helper is macOS only; build it on a Mac.');
  }
  const out = path.join(desktopDir, 'build', 'native');
  mkdirSync(out, { recursive: true });
  const binary = path.join(out, 'patch-audio');
  execFileSync(
    'swiftc',
    [
      '-O',
      '-target',
      'arm64-apple-macos14.4',
      path.join(desktopDir, 'native', 'patch-audio', 'main.swift'),
      '-o',
      binary,
    ],
    { stdio: 'inherit' },
  );
  return binary;
}

if (require.main === module) {
  console.log(`[build-native] ${buildNative()}`);
}

module.exports = { buildNative };
