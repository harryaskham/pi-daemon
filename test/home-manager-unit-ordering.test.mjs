import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const modulePath = fileURLToPath(
  new URL("../nix/home-manager-module.nix", import.meta.url),
);
const source = readFileSync(modulePath, "utf8");

/**
 * bd-178619: a user service that is `WantedBy = default.target` must never also
 * declare `After = default.target`. systemd resolves
 *   main.start -> default.target.start -> web.start -> main.start
 * as a cyclic transaction and silently deletes the main start job, leaving the
 * instance permanently inactive with a pending job that `systemctl start`
 * cannot clear ("Transaction order is cyclic").
 */
describe("generated systemd user units (bd-178619)", () => {
  it("never orders a unit after a target it is WantedBy", () => {
    const offenders = [];
    const afterPattern = /After\s*=\s*\[([^\]]*)\]/g;
    for (const match of source.matchAll(afterPattern)) {
      const entries = match[1];
      if (entries.includes('"default.target"')) {
        offenders.push(match[0].replace(/\s+/g, " "));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `units must not order themselves after default.target while being WantedBy it: ${offenders.join(", ")}`,
    );
  });

  it("keeps every instance unit installed into default.target", () => {
    const installs = source.match(/Install\.WantedBy\s*=\s*\["default\.target"\]/g) ?? [];
    assert.ok(
      installs.length >= 3,
      "instance, dedicated web, and watchdog units must remain WantedBy default.target",
    );
  });

  it("orders the main instance unit after basic.target instead", () => {
    assert.match(source, /After\s*=\s*\["basic\.target"\]/);
  });

  it("preserves the dedicated web dependency on its own instance service", () => {
    assert.match(source, /After\s*=\s*\["\$\{serviceName name\}\.service"\]/);
    assert.match(source, /Requires\s*=\s*\["\$\{serviceName name\}\.service"\]/);
  });
});
