import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

async function source(relative) {
  try {
    return await readFile(path.join(root, relative), "utf8");
  } catch (error) {
    assert.fail(`${relative} must exist for the live interactive contract: ${error.code ?? error.message}`);
  }
}

test("interactive app delegates exact authority correlation tree and TUI state to canonical SDK models", async () => {
  const [machine, repository, screen, activity, commands, rich] = await Promise.all([
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/LiveInteractiveSession.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/LiveReadonlyRepository.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/LiveReadonlyScreen.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/MainActivity.kt"),
    source("android/sdk-core/src/main/kotlin/com/harryaskham/pidroid/sdk/core/InteractiveCommands.kt"),
    source("android/sdk-session-ui/src/main/kotlin/com/harryaskham/pidroid/sessionui/RichInteractiveModels.kt"),
  ]);

  assert.match(machine, /InteractiveSessionController/);
  assert.match(machine, /CorrelationId\(idempotencyKey\)/);
  assert.match(machine, /CommandLifecycle\.INDETERMINATE|controller\.onDisconnect\(\)/);
  assert.match(machine, /SessionTreeSnapshot/);
  assert.match(machine, /TuiFrameDecoder/);
  assert.match(machine, /TuiFrameReducer/);
  assert.doesNotMatch(machine, /canReplay\([^)]*\)\s*=\s*true|blind.?replay/i);
  assert.match(repository, /SessionRole\.OBSERVER/);
  assert.match(repository, /requestControl\(\)/);
  assert.match(repository, /UUID\.randomUUID\(\)/);
  assert.match(repository, /interactive_send_indeterminate/);
  assert.match(repository, /INTERACTIVE_SAFE_CODE\s*=\s*Regex\("\^\[a-z\]\[a-z0-9_\]\{0,127\}\$"\)/);
  assert.match(repository, /code\.takeIf\(INTERACTIVE_SAFE_CODE::matches\) \?: "interactive_failed"/);
  assert.match(screen, /RichInteractiveSessionSurface/);
  assert.match(screen, /SessionTreeSurface/);
  assert.match(screen, /TuiSurface/);
  assert.match(screen, /Reconnect interactive session/);
  assert.match(screen, /ACTION RECEIVED · CONNECTING/);
  assert.match(screen, /INTERACTIVE ERROR · PREFLIGHT_ERROR/);
  assert.match(screen, /InteractiveControllerRole\.REQUESTING/);
  assert.match(activity, /handleInteraction/);
  assert.match(commands, /fun getTree\(\)/);
  assert.match(rich, /fun requesting\(/);
  assert.match(rich, /fun lost\(/);
});

test("disposable interactive proof uses private identity bounded cleanup and physical evidence", async () => {
  const [proof, selector, selectorFixture, server] = await Promise.all([
    source("android/build-logic/live-interactive-proof.sh"),
    source("android/build-logic/uiautomator-control-center.py"),
    source("fixtures/android/uiautomator.request-control.xml"),
    source("scripts/pi-droid-disposable-daemon.mjs"),
  ]);

  assert.match(proof, /set -euo pipefail/);
  assert.match(proof, /umask 077/);
  assert.match(proof, /mktemp -d/);
  assert.match(proof, /trap cleanup EXIT/);
  assert.match(proof, /reserve_port_pair/);
  assert.match(proof, /emulator_abi='x86_64'/);
  assert.match(proof, /adb[^\n]*get-state/);
  assert.doesNotMatch(proof, /adb[^\n]*wait-for-device/);
  assert.match(proof, /openssl rand -hex 32/);
  assert.match(proof, /--interactive/);
  assert.match(proof, /tap_text "Request control"/);
  assert.match(proof, /ACTION RECEIVED · CONNECTING\|REQUESTING\|CONTROLLER\|INTERACTIVE ERROR/);
  assert.match(proof, /wait_ui 'REQUESTING\|CONTROLLER'/);
  assert.match(proof, /uiautomator-control-center\.py/);
  assert.match(selector, /clickable ancestor/);
  assert.match(selector, /item\.attrib\.get\("text"\) != label/);
  assert.match(selector, /control has no clickable ancestor/);
  assert.match(selectorFixture, /text="Request control"/);
  assert.match(selectorFixture, /content-desc="Request session control"/);
  assert.match(selectorFixture, /clickable="true"[^>]*bounds="\[626,1682\]\[1012,1787\]"/);
  assert.match(proof, /hold-until-disconnect/);
  assert.match(proof, /PROMPT INDETERMINATE/);
  assert.match(proof, /Show tree presentation/);
  assert.match(proof, /Show tui presentation/);
  assert.match(proof, /screenrecord/);
  assert.match(proof, /screencap/);
  assert.match(proof, /reconnected-controller-phone\.png/);
  assert.match(proof, /reconnected-controller-tablet\.png/);
  assert.match(proof, /live-interactive-sha256sums\.txt/);
  assert.match(proof, /blindReplay\": false/);
  assert.doesNotMatch(proof, /(?:7463|8080|3000)/);
  assert.match(server, /options\.interactive/);
  assert.match(server, /ShadowTuiAttachmentManager/);
  assert.match(server, /command\.type === "prompt"/);
  assert.match(server, /command\.type === "get_tree"/);
  assert.match(server, /hold-until-disconnect/);
});
