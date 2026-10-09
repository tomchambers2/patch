# Patch Native App Testing Guide for AI Agents

How to test the patch surfaces — server, host, web, Electron desktop, Android, terminal CLI, voice device — using simulators, emulators, system automation, and harness mocks. Written for AI agents (Claude Code, etc.) that need to see, interact with, and verify behaviour without human involvement.

## The Problem

Web testing alone misses too much. Patch ships across:

- A real Hetzner box with a host spawning Claude Code SDK sessions
- A web SPA with WebSocket presence
- An Electron shell with tray, global hotkey, native notifications
- An Android app with `ConnectionService`, foreground services, FCM
- A custom ESP32-S3 firmware over a long-lived WSS

Each layer has its own failure modes (stuck WebSockets, native permission dialogs, foreground-service kills, OTA-flash crashes) that only show up on the real surface.

## Contents

1. [Server + host harness](server-daemon.md) — `docker compose -f docker-compose.test.yml`, fixtures, latency budgets
2. [Android Emulator Testing](android-emulator.md) — Setup, ADB interaction, screenshots
3. [macOS Desktop Testing](macos-desktop.md) — Window management, system tray, AppleScript automation, Electron remote debugging
4. [Electron-specific tests](electron.md) — Tray menus, global hotkey, native notifications, auto-update
5. [Voice device testing](voice-device.md) — Mock harness, real-device OTA, fixture audio
6. [QR pairing](qr-pairing.md) — Surface-to-surface device linking
7. [Multiple Playwright tests](multiple-playwright-tests.md) — How to run concurrent agents without browser conflicts
8. [What To Test](what-to-test.md) — Comprehensive checklist for any surface
9. [Limitations](limitations.md) — What can't be tested programmatically and workarounds

## Out of scope

- iOS Simulator testing — patch is Android-only.
- Login / magic-link flows — patch uses Claude OAuth + device-to-device QR pairing; no email step.
