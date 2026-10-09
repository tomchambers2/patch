const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { _electron } = require('../../web/node_modules/@playwright/test');

test(
  'a second desktop process preserves the first profile and raises its window',
  {
    skip: process.env.PATCH_REAL_DESKTOP !== '1',
    timeout: 60000,
  },
  async () => {
    const profile = mkdtempSync(path.join(tmpdir(), 'patch-instance-test-'));
    const server = createServer((_req, res) => res.end('<html><body>Profile test</body></html>'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const executablePath = process.env.PATCH_TEST_DESKTOP_BINARY || require('electron');
    const entry = path.join(profile, 'entry.cjs');
    writeFileSync(
      entry,
      `require(${JSON.stringify(path.resolve(__dirname, '../dist/main.js'))}).bootstrap();`,
    );
    const args = process.env.PATCH_TEST_DESKTOP_BINARY
      ? [`--user-data-dir=${profile}`]
      : [entry, `--user-data-dir=${profile}`];
    const env = {
      ...process.env,
      PATCH_SERVER_URL: `http://127.0.0.1:${server.address().port}/app/`,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let first, second;
    try {
      first = await _electron.launch({ executablePath, args, env });
      const page = await first.firstWindow({ timeout: 10000 });
      await page.waitForLoadState();
      await page.evaluate(() =>
        localStorage.setItem('patch.credential.v1', 'test-profile-sentinel'),
      );
      await first.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
      second = spawn(executablePath, args, { env, stdio: 'ignore' });
      const exit = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve('still-running'), 5000);
        second.once('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      assert.equal(exit, 0, 'duplicate must exit before opening the shared storage');
      assert.equal(
        await first.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
        true,
      );
      assert.equal(
        await page.evaluate(() => localStorage.getItem('patch.credential.v1')),
        'test-profile-sentinel',
      );
      await first.close();
      first = null;
      first = await _electron.launch({ executablePath, args, env });
      const restarted = await first.firstWindow({ timeout: 10000 });
      await restarted.waitForLoadState();
      assert.equal(
        await restarted.evaluate(() => localStorage.getItem('patch.credential.v1')),
        'test-profile-sentinel',
      );
    } finally {
      if (second && second.exitCode === null) second.kill('SIGTERM');
      if (first) await first.close();
      await new Promise((resolve) => server.close(resolve));
      rmSync(profile, { recursive: true, force: true });
    }
  },
);
