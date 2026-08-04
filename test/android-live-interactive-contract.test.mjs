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
  assert.match(repository, /interactiveCommands: Set<PiRpcCommandType>/);
  assert.match(repository, /supportedCommands = selected\.interactiveCommands/);
  assert.equal((repository.match(/client\.capabilities\(\)/g) ?? []).length, 1);
  assert.match(repository, /fun connectInteractiveObserver\(\)/);
  assert.match(repository, /interactiveConnectMutex\.withLock/);
  assert.match(repository, /interactive_credential_failed/);
  assert.match(repository, /interactive_capabilities_failed/);
  assert.match(repository, /observer_connect_failed/);
  assert.match(repository, /interactive_tui_open_failed/);
  assert.match(repository, /requestControl\(\)/);
  assert.match(repository, /requireActiveInteractive\(\)/);
  assert.match(repository, /UUID\.randomUUID\(\)/);
  assert.match(repository, /interactive_send_indeterminate/);
  assert.match(repository, /INTERACTIVE_SAFE_CODE\s*=\s*Regex\("\^\[a-z\]\[a-z0-9_\]\{0,127\}\$"\)/);
  assert.match(repository, /code\.takeIf\(INTERACTIVE_SAFE_CODE::matches\) \?: "interactive_failed"/);
  assert.match(repository, /LiveReadonlyFailure\("interactive_attach_failed"\)/);
  assert.match(repository, /publishInteractive\(active, "interactive_send_indeterminate"\)/);
  assert.match(repository, /throw LiveReadonlyFailure\("interactive_send_indeterminate"\)/);
  assert.match(repository, /safeCode == "interactive_failed"[^\n]*existing\.code != "interactive_failed"/);
  assert.match(screen, /RichInteractiveSessionSurface/);
  assert.match(screen, /SessionTreeSurface/);
  assert.match(screen, /TuiSurface/);
  assert.match(screen, /Reconnect interactive session/);
  assert.match(screen, /ACTION RECEIVED · CONNECTING/);
  assert.match(screen, /OBSERVER · READY/);
  assert.match(screen, /Connect interactive observer/);
  assert.match(screen, /enabled = interaction !is LiveInteractiveAppState\.Connecting/);
  assert.match(screen, /INTERACTIVE ERROR · PREFLIGHT_ERROR/);
  assert.match(screen, /InteractiveControllerRole\.REQUESTING/);
  assert.match(activity, /connectInteractiveObserver/);
  assert.match(activity, /handleInteraction/);
  assert.match(activity, /is CommandAdmissionException -> error\.code/);
  assert.match(activity, /fun safeInteractiveFailureCode/);
  assert.match(activity, /INTERACTIVE_FAILURE_CODE/);
  assert.doesNotMatch(activity, /host_unavailable_\$\{error::class/);
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
  const gateStart = proof.indexOf("wait_emulator_host_port()");
  const gateEnd = proof.indexOf("\n}\n\n", gateStart);
  const hostPortGate = proof.slice(gateStart, gateEnd);
  assert.ok(gateStart >= 0 && gateEnd > gateStart);
  assert.match(hostPortGate, /max_attempts=60/);
  assert.match(hostPortGate, /deadline_seconds=30/);
  assert.match(hostPortGate, /toybox nc -z -w 1 10\.0\.2\.2/);
  assert.match(hostPortGate, /sleep 0\.5/);
  assert.match(hostPortGate, /host_port_unreachable/);
  assert.doesNotMatch(hostPortGate, /token|bearer|authorization|https?:\/\//i);
  assert.ok(proof.indexOf("\nif ! wait_emulator_host_port") < proof.indexOf("shell am start"));
  assert.match(proof, /--interactive/);
  assert.match(proof, /tap_text "Request control"/);
  assert.match(proof, /tap_text "Connect interactive observer"/);
  assert.match(proof, /ACTION RECEIVED · CONNECTING\|OBSERVER · READY\|INTERACTIVE ERROR · PREFLIGHT_ERROR/);
  assert.match(proof, /wait_ui 'OBSERVER · READY'/);
  assert.match(proof, /wait_ui 'REQUESTING\|CONTROLLER'/);
  assert.ok(proof.indexOf('wait_ui \'OBSERVER · READY\'') < proof.indexOf('tap_text "Request control"'));
  assert.match(proof, /uiautomator-control-center\.py/);
  assert.match(selector, /clickable ancestor/);
  assert.match(selector, /item\.attrib\.get\("text"\) != label/);
  assert.match(selector, /control has no clickable ancestor/);
  assert.match(selectorFixture, /text="Request control"/);
  assert.match(selectorFixture, /content-desc="Request session control"/);
  assert.match(selectorFixture, /clickable="true"[^>]*bounds="\[626,1682\]\[1012,1787\]"/);
  assert.match(proof, /hold-until-disconnect/);
  assert.match(proof, /PROMPT INDETERMINATE/);
  const promptSucceeded = proof.indexOf('screenshots/prompt-succeeded.png');
  const dismissIme = proof.indexOf('keyevent KEYCODE_BACK');
  const waitForTree = proof.indexOf('wait_control "Show tree presentation" 30');
  const tapTree = proof.indexOf('shell input tap "$tree_x" "$tree_y"');
  assert.ok(promptSucceeded >= 0 && promptSucceeded < dismissIme);
  assert.ok(dismissIme < waitForTree && waitForTree < tapTree);
  assert.match(proof, /tree_control_occluded/);
  assert.match(proof, /tree-control-occluded\.xml/);
  assert.match(proof, /tree-control-occluded\.png/);
  assert.match(proof, /tree-control-occluded-sha256sums\.txt/);
  assert.match(proof, /Show tree presentation/);
  assert.match(proof, /Show tui presentation/);
  assert.match(proof, /screenrecord/);
  assert.match(proof, /screencap/);
  assert.match(proof, /reconnected-controller-phone\.png/);
  assert.match(proof, /reconnected-controller-tablet\.png/);
  assert.match(proof, /live-interactive-sha256sums\.txt/);
  assert.match(proof, /emulator-host-port-gate\.log/);
  assert.match(proof, /"hostPortGate": true/);
  assert.match(proof, /blindReplay\": false/);
  assert.doesNotMatch(proof, /(?:7463|8080|3000)/);
  assert.match(server, /options\.interactive/);
  assert.match(server, /ShadowTuiAttachmentManager/);
  assert.match(server, /command\.type === "prompt"/);
  assert.match(server, /command\.type === "get_tree"/);
  assert.match(server, /request_control/);
  assert.match(server, /control_granted/);
  assert.match(server, /controlGrant: rpcProbe\.controlGrant/);
  assert.match(server, /hold-until-disconnect/);
});
