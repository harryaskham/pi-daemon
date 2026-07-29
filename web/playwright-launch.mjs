/**
 * Browser launch options for the Dash suite, shared by the Playwright config
 * and the launch preflight so the two can never disagree.
 *
 * Chromium's default sandbox needs unprivileged user namespaces, and its
 * default shared-memory usage needs a normally-sized `/dev/shm`. A hardened CI
 * runner may supply neither, in which case the browser exits during startup and
 * Playwright reports `Target page, context or browser has been closed` once per
 * scenario without ever naming the cause (bd-df1c84).
 *
 * Relaxing those protections is acceptable only where the browser loads nothing
 * but our own build over loopback, on an already-isolated runner, so it is
 * opt-in per environment through `PI_DAEMON_E2E_NO_SANDBOX` and is never the
 * default on a developer machine.
 *
 * Lives in a plain module so the wiring can be asserted structurally rather than
 * by matching config source text.
 */

/** Environment variable that opts an environment out of the browser sandbox. */
export const NO_SANDBOX_ENV = "PI_DAEMON_E2E_NO_SANDBOX";

/**
 * Arguments applied only when an environment has opted out of the sandbox.
 *
 * `--no-sandbox` and `--disable-dev-shm-usage` alone were not enough on the
 * self-hosted runners: with both applied, `DEBUG=pw:browser` showed the browser
 * still dying with `Zygote could not fork: process_type gpu-process numfds 4
 * child_pid -1`, repeated for the renderer, ending in SIGSEGV. `child_pid -1`
 * means the zygote's own `fork` failed for every child type, which a hardened
 * service unit causes through its process/namespace restrictions rather than
 * through anything about the sandbox or shared memory (`/dev/shm` had 23 GiB
 * free on that runner). `--no-zygote` removes the forking helper entirely and
 * requires `--no-sandbox`, which is already present; `--disable-gpu` drops the
 * GPU process a headless CI browser has no use for (bd-e3fa3e).
 */
export const NO_SANDBOX_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-zygote",
];

/**
 * Launch options for the audited browser.
 *
 * @param {NodeJS.ProcessEnv} [env] Environment to read; defaults to the process
 *   environment. Injectable so the behaviour is testable without mutating it.
 */
export function browserLaunchOptions(env = process.env) {
  return env[NO_SANDBOX_ENV] === "1" ? { args: [...NO_SANDBOX_ARGS] } : {};
}
