// The shell's view of the first-run bundle (dist/first-run.cjs, built from
// src/first-run by scripts/bundle-first-run.mjs). Declared here, by hand, because
// the bundle's sources use ES-module packages this CommonJS project's compiler
// cannot resolve; `src/first-run/tsconfig.json` type-checks the other side.

export type SetupChoice = { kind: 'local' } | { kind: 'remote'; input: string };

export interface FirstRunApi {
  launch(env: {
    userData: string;
    home: string;
    resources: string;
    execPath: string;
    relayUrl: string;
    label: string;
    ui: {
      choose(): Promise<SetupChoice>;
      progress(message: string): void;
      fail(message: string): void;
    };
    installHost(
      origin: string,
      code: string,
    ): Promise<{ ok: boolean; exitCode: number | null; output: string }>;
    hostInstalled(): boolean;
  }): Promise<{ appUrl: string; stop(): Promise<void> }>;
  forgetConnection(userData: string): void;
  remembered(userData: string): { connection: { mode: 'local' | 'remote' | 'relay' } } | null;
}

/** Load the bundle. A missing one is a build that was not finished: an error, not a shell without first run. */
export function loadFirstRun(): FirstRunApi {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./first-run.cjs') as FirstRunApi;
}
