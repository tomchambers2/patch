/**
 * Turn a death that happened OUTSIDE the deploy's `failures` machinery into the
 * same report a named surface failure gets.
 *
 * `ship.mjs` collects failures in `surface()` and reports them in its last few
 * lines. Everything before the lanes — the build-tree pin, `buildWorkspaceLibs()`
 * and above all `testGate()` — is called bare at the top level, so a throw there
 * unwinds past that reporting entirely and Node exits with a raw stack trace. A
 * detached deploy has no console anyone reads, so that exit is SILENT: on
 * 2026-09-13 two runs died in the browser layer of the gate and nothing said so
 * for 22 hours, while the phone sat on a wire schema that could not parse a job
 * with a gate.
 *
 * A failing gate is the commonest way a deploy ends, and it was the one ending
 * that reported nothing. This retries nothing and degrades nothing: the process
 * still dies, still exits non-zero, and ships nothing it did not ship. It just
 * says so on the way out.
 */
export function makeCrashReporter({ notify, currentCommit, exit, log = console.error }) {
  return (err) => {
    // A rejection can carry anything, not just an Error — `String(err)` keeps a
    // thrown string or object readable instead of reporting "undefined".
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`\nDEPLOY FAILED\n${detail}`);
    // Read the commit through a getter, not a captured value: this reporter is
    // installed before the sha is resolved, and the whole point is that it must
    // also work for a crash that happens before there is one to name. The caller
    // holds it in a `let` for the same reason — `typeof` on the `const info`
    // declared further down THROWS while it is in its temporal dead zone, which
    // inside a crash handler would replace the real failure with a ReferenceError.
    const at = currentCommit();
    const where = at ? `${at.version} / ${at.gitSha}` : 'before the commit was resolved';
    notify('Patch deploy FAILED', `${where}\n${detail}`, 'high');
    exit(1);
  };
}
