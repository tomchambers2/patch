#!/usr/bin/env node
// Signing keys belong to the logged-in macOS audit session, not an SSH session.
// Launch only this command in that session; never copy or persist a password.
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const [mode, ...args] = process.argv.slice(2);
if (mode === '--worker') {
  const [dir, command, ...commandArgs] = args;
  const finish = (result) => {
    writeFileSync(join(dir, 'result.new'), JSON.stringify(result));
    renameSync(join(dir, 'result.new'), join(dir, 'result.json'));
  };
  const child = spawn(command, commandArgs, {
    stdio: 'inherit',
    env: { ...process.env, PATCH_MAC_GUI_JOB: '1' },
  });
  child.once('error', (error) => {
    finish({ code: 1, error: error.message });
    process.exitCode = 1;
  });
  child.once('close', (code) => {
    finish({ code: code ?? 1 });
    process.exitCode = code ?? 1;
  });
} else {
  if (process.platform !== 'darwin' || !mode)
    throw new Error('Usage on macOS: mac-gui-run.mjs <command> [args]');
  const root = join(homedir(), '.patch-deploy-build', 'gui-jobs');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, 'job-'));
  const label = 'me.tomchambers.patch.build-' + randomUUID();
  const domain = `gui/${process.getuid()}`;
  const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const string = (s) => `<string>${xml(s)}</string>`;
  const command = [
    process.execPath,
    fileURLToPath(import.meta.url),
    '--worker',
    dir,
    mode,
    ...args,
  ];
  const plist = join(dir, 'job.plist');
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
    <key>Label</key>${string(label)}
    <key>ProgramArguments</key><array>${command.map(string).join('')}</array>
    <key>WorkingDirectory</key>${string(process.cwd())}
    <key>EnvironmentVariables</key><dict><key>PATH</key>${string(process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin')}<key>HOME</key>${string(homedir())}</dict>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key>${string(join(dir, 'stdout.log'))}
    <key>StandardErrorPath</key>${string(join(dir, 'stderr.log'))}
  </dict></plist>`,
    { mode: 0o600 },
  );
  let loaded = false;
  let succeeded = false;
  const offsets = new Map();
  const drain = () => {
    for (const name of ['stdout.log', 'stderr.log']) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      const data = readFileSync(path);
      const from = offsets.get(name) ?? 0;
      if (data.length > from)
        (name === 'stderr.log' ? process.stderr : process.stdout).write(data.subarray(from));
      offsets.set(name, data.length);
    }
  };
  try {
    execFileSync('launchctl', ['bootstrap', domain, plist]);
    loaded = true;
    const deadline = Date.now() + 20 * 60_000;
    while (!existsSync(join(dir, 'result.json'))) {
      drain();
      if (Date.now() > deadline) throw new Error(`GUI build timed out; logs: ${dir}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    drain();
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
    if (result.code !== 0) throw new Error(`GUI command failed (${result.code}); logs: ${dir}`);
    succeeded = true;
  } finally {
    if (loaded) execFileSync('launchctl', ['bootout', `${domain}/${label}`]);
    if (succeeded) rmSync(dir, { recursive: true });
  }
}
