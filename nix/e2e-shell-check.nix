# Contract check for the Dash browser-acceptance development shell.
#
# The property is what `nix develop .#e2e` exports, so this asserts the exported
# values by evaluation instead of matching `flake.nix` source text from a test in
# another lane. Source matching is a proxy: it fails when a legitimate edit
# changes a string, and it passes when a reformat happens to preserve one.
#
# The validation is expressed once and run twice: against the real shell, which
# must pass, and against a table of deliberately broken inputs, each of which
# must fail. That second half is a checked-in negative control - evidence that
# the check can still reject, rather than an assumption that it would.
#
# Costs nothing beyond a tiny derivation. The browsers path arrives with its
# string context discarded by the caller, so the ~2.1 GiB Playwright closure is
# not a build input here.
{
  pkgs,
  shell,
  webPackage,
  justfile,
}: let
  # Every value handed to the derivation must be free of string context.
  #
  # A value carrying context is a store-path reference, and placing one in this
  # derivation's environment adds that closure to its build inputs - which for
  # the browsers bundle means ~2.1 GiB fetched on every `nix flake check`. The
  # caveat is easy to state and easy to forget, so it fails here at evaluation
  # with the cause named, rather than silently as a slow check later.
  noContext = name: value:
    if builtins.hasContext value
    then
      throw ''
        e2e-shell-check: ${name} carries a store-path reference.
        Placing it in the check's environment would pull that closure into every
        `nix flake check`. Discard the context with
        builtins.unsafeDiscardStringContext, or assert an attribute that carries
        no store path.
      ''
    else value;

  browsersPath = noContext "PLAYWRIGHT_BROWSERS_PATH" shell.PLAYWRIGHT_BROWSERS_PATH;
  skipDownload = noContext "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD" shell.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
  driverVersion = noContext "PI_DAEMON_PLAYWRIGHT_DRIVER_VERSION" shell.PI_DAEMON_PLAYWRIGHT_DRIVER_VERSION;
  pinnedPlaywright = noContext "@playwright/test pin" webPackage.devDependencies."@playwright/test";
in
  pkgs.runCommand "pi-daemon-e2e-shell-check" {
    nativeBuildInputs = [pkgs.just];
    inherit browsersPath skipDownload driverVersion pinnedPlaywright;
    justfileSource = justfile;
  } ''
    # validate <browsers-path> <skip-download> <driver-version> <pinned-version>
    # Prints the reason and returns non-zero when the contract is broken.
    validate() {
      # A browser bundle must be supplied, or Playwright falls back to a
      # download that cannot run on a library-strict host - the failure this
      # shell exists to prevent.
      case "$1" in
        /nix/store/*playwright-browsers*) ;;
        "") echo "PLAYWRIGHT_BROWSERS_PATH is empty"; return 1 ;;
        *) echo "PLAYWRIGHT_BROWSERS_PATH is not a Nix playwright-browsers path: $1"; return 1 ;;
      esac

      # And the fallback download must be refused rather than merely
      # unnecessary, so a partial bundle fails loudly instead of silently
      # fetching.
      if [ "$2" != "1" ]; then
        echo "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is '$2', expected 1"
        return 1
      fi

      # Playwright resolves browsers by revision, so the npm pin and the nixpkgs
      # driver must be the same version. The runtime preflight enforces this
      # before a launch; asserting it here fails a dependency bump in the Nix
      # lane instead of at someone's first browser run.
      if [ -z "$3" ]; then
        echo "PI_DAEMON_PLAYWRIGHT_DRIVER_VERSION is empty"
        return 1
      fi
      if [ "$3" != "$4" ]; then
        echo "nixpkgs playwright-driver is $3 but web/package.json pins @playwright/test $4; align them or the audited browsers cannot serve the pinned Playwright"
        return 1
      fi
      return 0
    }

    if ! reason="$(validate "$browsersPath" "$skipDownload" "$driverVersion" "$pinnedPlaywright")"; then
      echo "e2e shell contract: $reason" >&2
      exit 1
    fi

    # Negative control: prove the validation still rejects. Each tuple breaks
    # exactly one clause, so a future edit that hollows one out fails here
    # rather than passing silently.
    reject() {
      if validate "$2" "$3" "$4" "$5" >/dev/null; then
        echo "e2e shell contract: validation accepted a broken shell ($1)" >&2
        exit 1
      fi
    }
    reject "no browser bundle" "" 1 1.60.0 1.60.0
    reject "bundle is not the audited one" /usr/lib/chromium 1 1.60.0 1.60.0
    reject "download fallback still permitted" "$browsersPath" 0 1.60.0 1.60.0
    reject "driver and npm pin disagree" "$browsersPath" 1 1.60.0 1.61.1
    reject "driver version absent" "$browsersPath" 1 "" 1.60.0

    # The documented entry point must exist as a recipe, observed by asking just
    # rather than by grepping the Justfile.
    just --justfile "$justfileSource" --working-directory . --summary \
      | tr ' ' '\n' | grep -qx dash-e2e \
      || {
      echo "e2e shell contract: the Justfile declares no dash-e2e recipe" >&2
      exit 1
    }

    echo "e2e shell contract: browsers=$browsersPath driver=$driverVersion pinned=$pinnedPlaywright" > "$out"
  ''
