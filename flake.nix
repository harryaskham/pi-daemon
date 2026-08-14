{
  description = "Pi Daemon: one long-lived Pi SDK host for many logical agent sessions";

  # Match the fleet's pinned, already-cached nixpkgs revision.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/d407951447dcd00442e97087bf374aad70c04cea";

  outputs = {
    self,
    nixpkgs,
    ...
  }: let
    systems = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-darwin"
      "x86_64-linux"
    ];
    forAllSystems = nixpkgs.lib.genAttrs systems;
    piDroidSdkPublicationVersion = let
      prefix = "version=";
      versionLines =
        builtins.filter
        (line: nixpkgs.lib.hasPrefix prefix line)
        (nixpkgs.lib.splitString "\n" (builtins.readFile ./android/sdk-publication.properties));
    in
      if builtins.length versionLines == 1
      then nixpkgs.lib.removePrefix prefix (builtins.head versionLines)
      else throw "android/sdk-publication.properties must contain exactly one version";

    # Single source of truth for the pinned npm dependency cache. Refresh this
    # block with `npm run nix:deps-hash` after any package-lock.json change; the
    # `npm-deps-lock` marker is a plain staleness signal that lets CI flag a
    # stale pin without needing Nix on the runner.
    # npm-deps-lock: sha256-RZQOr8pPQjEvj+t82eSsMhUL5SqH/bYGgOOD7Cr9vl4=
    npmDepsHash = "sha256-FOKSxsmetVfWvBQWrPuzBRayQgVt82c0KuRLSKP/Elo=";
    # One contract selects the hermetic API 36 image for the flake closure and
    # every diagnostic/physical harness. The pinned nixpkgs catalog has no
    # aosp_atd or google_atd at API 36; keep those assertions so a future pin
    # adding ATD fails evaluation until the optimized image is reviewed.
    androidEmulatorSystemImage =
      builtins.fromJSON (builtins.readFile ./android/build-logic/emulator-system-image.json);
    androidSdkCatalog = builtins.fromJSON (
      builtins.readFile "${nixpkgs}/pkgs/development/mobile/androidenv/repo.json"
    );
    androidApiImageCatalog =
      androidSdkCatalog.images.${toString androidEmulatorSystemImage.apiLevel};
    androidSystemImagePackage =
      "system-images;android-${toString androidEmulatorSystemImage.apiLevel};"
      + "${androidEmulatorSystemImage.imageType};${androidEmulatorSystemImage.abi}";
    androidSystemImageDirectory =
      "system-images/android-${toString androidEmulatorSystemImage.apiLevel}/"
      + "${androidEmulatorSystemImage.imageType}/${androidEmulatorSystemImage.abi}/";
    androidSystemImageContractValid = assert androidEmulatorSystemImage.schemaVersion == 1;
    assert !builtins.hasAttr "aosp_atd" androidApiImageCatalog;
    assert !builtins.hasAttr "google_atd" androidApiImageCatalog;
    assert androidEmulatorSystemImage.aospAtdAvailableInPinnedCatalog == false;
    assert androidEmulatorSystemImage.googleAtdAvailableInPinnedCatalog == false;
    assert androidEmulatorSystemImage.googleApisRequired == false;
    assert androidEmulatorSystemImage.googlePlayServicesRequired == false;
    assert androidEmulatorSystemImage.googlePlayStoreRequired == false;
    assert androidEmulatorSystemImage.package == androidSystemImagePackage;
    assert androidEmulatorSystemImage.directory == androidSystemImageDirectory;
    assert builtins.hasAttr androidEmulatorSystemImage.imageType androidApiImageCatalog;
    assert builtins.hasAttr androidEmulatorSystemImage.abi (
      builtins.getAttr androidEmulatorSystemImage.imageType androidApiImageCatalog
    ); let
      selected = builtins.getAttr androidEmulatorSystemImage.abi (
        builtins.getAttr androidEmulatorSystemImage.imageType androidApiImageCatalog
      );
    in
      selected.path
      == builtins.substring 0 (builtins.stringLength androidSystemImageDirectory - 1)
      androidSystemImageDirectory;
    androidReleaseSdkFor = system: let
      # Android SDK/emulator artifacts are licensed and unfree. This import is
      # used only by the explicit image package and heavy release shell.
      androidPkgs = import nixpkgs {
        inherit system;
        config = {
          allowUnfree = true;
          android_sdk.accept_license = true;
        };
      };
    in
      assert androidSystemImageContractValid;
        androidPkgs.androidenv.composeAndroidPackages {
          platformVersions = [(toString androidEmulatorSystemImage.apiLevel)];
          buildToolsVersions = ["36.0.0"];
          includeEmulator = true;
          includeSystemImages = true;
          systemImageTypes = [androidEmulatorSystemImage.imageType];
          abiVersions = [androidEmulatorSystemImage.abi];
          includeNDK = false;
        };
  in {
    homeManagerModules.pi-daemon = import ./nix/home-manager-module.nix {inherit self;};
    homeManagerModules.default = self.homeManagerModules.pi-daemon;

    lib.piDroidSdkMavenArchive = {
      pkgs,
      repository,
      version ? piDroidSdkPublicationVersion,
    }:
      assert version == piDroidSdkPublicationVersion;
        import ./nix/pi-droid-sdk-maven-archive.nix {
          inherit pkgs repository version;
        };

    packages = forAllSystems (system: let
      pkgs = import nixpkgs {inherit system;};
      androidReleaseSdk = androidReleaseSdkFor system;
      npmDeps = import ./nix/npm-deps.nix {
        inherit pkgs;
        hash = npmDepsHash;
      };
      phaseStart = phase: ''
        started_epoch="$(date +%s)"
        printf '%s\n' "$started_epoch" > "$NIX_BUILD_TOP/pi-daemon-${phase}-started"
        printf 'pi-daemon-nix-phase phase=${phase} event=start epoch=%s utc=%s\n' \
          "$started_epoch" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
      '';
      phaseFinish = phase: ''
        started_epoch="$(cat "$NIX_BUILD_TOP/pi-daemon-${phase}-started")"
        finished_epoch="$(date +%s)"
        printf 'pi-daemon-nix-phase phase=${phase} event=finish epoch=%s utc=%s duration_seconds=%s\n' \
          "$finished_epoch" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
          "$((finished_epoch - started_epoch))"
      '';
      ciBuildNonce = builtins.getEnv "PI_DAEMON_NIX_CI_BUILD_NONCE";
      packageAttrs = {
        pname = "pi-daemon";
        version = "0.3.1";
        src = ./.;

        nodejs = pkgs.nodejs_24;
        inherit npmDeps;
        npmDepsFetcherVersion = 2;
        # bd-833b3e: npm retry tests execute a Bash fixture. NixOS/sandbox has
        # no /bin/bash and does not export BASH, so put the pinned Nix Bash on
        # the package check PATH rather than making JavaScript guess a host path.
        nativeBuildInputs = [pkgs.makeWrapper pkgs.openssl pkgs.bash pkgs.python3];

        npmBuildScript = "build";
        preBuild = phaseStart "build";
        postBuild = phaseFinish "build";
        preCheck = phaseStart "check";
        postCheck = phaseFinish "check";
        preInstall = phaseStart "install";
        postInstall = phaseFinish "install";
        preFixup = phaseStart "fixup";
        postFixup = phaseFinish "fixup";
        preInstallCheck = phaseStart "install-check";
        postInstallCheck = phaseFinish "install-check";
        # Nix-on-Droid cannot safely run npm, so aarch64-linux artifacts are
        # prebuilt on x86_64 NixOS through binfmt and served from Attic. The full
        # Node suite is not QEMU-stable (RSS reports zero and bounded subprocess
        # tests exceed their real-hardware deadlines); Linux x86_64 and macOS CI
        # remain the authoritative test gates. Deterministic installed version
        # checks still run in doInstallCheck below on every platform.
        doCheck = system != "aarch64-linux";
        checkPhase = ''
          runHook preCheck
          npm test
          runHook postCheck
        '';

        installPhase = ''
          runHook preInstall
          npm prune --omit=dev --ignore-scripts
          # The private Dash workspace is build-time source until bd-31ee8f
          # packages its compiled assets; never copy npm's source-tree symlink.
          rm -f node_modules/@harryaskham/pi-daemon-dash
          packageRoot="$out/lib/node_modules/@harryaskham/pi-daemon"
          mkdir -p "$packageRoot" "$out/bin"
          cp -R dist node_modules package.json CHANGELOG.md README.md SECURITY.md LICENSE \
            protocol.schema.json protocol-v2.schema.json tool-adapter.schema.json \
            session-api.schema.json session-api.openapi.json dashboard-api.schema.json \
            extension-view.schema.json dashboard-api.openapi.json dashboard-session-draft.schema.json \
            schedule.schema.json "$packageRoot/"
          makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/pi-daemon" \
            --add-flags "$packageRoot/dist/cli.js"
          makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/pi-daemon-rpc" \
            --add-flags "$packageRoot/dist/rpc-stdio-cli.js"
          runHook postInstall
        '';
        doInstallCheck = true;
        installCheckPhase = ''
          runHook preInstallCheck
          "$out/bin/pi-daemon" version | grep -Fx 0.3.1
          "$out/bin/pi-daemon-rpc" --version | grep -Fx 0.3.1
          runHook postInstallCheck
        '';

        meta = {
          description = "General-purpose daemon that multiplexes on-demand Pi SDK sessions";
          homepage = "https://github.com/harryaskham/pi-daemon";
          license = pkgs.lib.licenses.mit;
          mainProgram = "pi-daemon";
          platforms = systems;
        };
      };
      package = pkgs.buildNpmPackage (packageAttrs
        // pkgs.lib.optionalAttrs (ciBuildNonce != "") {
          # A GitHub run-attempt nonce intentionally changes only the CI package
          # derivation identity. Its output is therefore absent even on a warm
          # shared store, while every dependency remains reusable.
          PI_DAEMON_NIX_CI_BUILD_NONCE = ciBuildNonce;
        });
      pages =
        pkgs.runCommand "pi-daemon-pages" {
          nativeBuildInputs = [pkgs.pandoc];
        } ''
          mkdir -p "$out"
          cat > "$out/style.css" <<'CSS'
          :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.55; }
          body { max-width: 72rem; margin: 0 auto; padding: 2rem; }
          a { color: #3273dc; }
          pre { overflow-x: auto; padding: 1rem; background: color-mix(in srgb, CanvasText 8%, Canvas); }
          code { font-family: ui-monospace, monospace; }
          table { border-collapse: collapse; }
          th, td { border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas); padding: .4rem .6rem; }
          CSS
          cat > nested-links.lua <<'LUA'
          function Link(link)
            local target = link.target
            if target:match("^https?://") or target:match("^mailto:") or
               target:match("^#") or target:match("^/") or target:match("^%.%./") then
              return link
            end
            link.target = "../" .. target
            return link
          end
          LUA
          for source in ${./docs}/*.md; do
            name="$(basename "$source" .md)"
            filter=""
            if [ "$name" = index ]; then
              destination="$out/index.html"
              css="style.css"
            else
              mkdir -p "$out/$name"
              destination="$out/$name/index.html"
              css="../style.css"
              filter="--lua-filter=$PWD/nested-links.lua"
            fi
            pandoc "$source" \
              --standalone \
              --from=gfm+yaml_metadata_block \
              --to=html5 \
              --css="$css" \
              $filter \
              --output="$destination"
          done
          cp ${./protocol.schema.json} "$out/protocol.schema.json"
          cp ${./protocol-v2.schema.json} "$out/protocol-v2.schema.json"
          cp ${./tool-adapter.schema.json} "$out/tool-adapter.schema.json"
          cp ${./session-api.schema.json} "$out/session-api.schema.json"
          cp ${./session-api.openapi.json} "$out/session-api.openapi.json"
          cp ${./dashboard-api.schema.json} "$out/dashboard-api.schema.json"
          cp ${./extension-view.schema.json} "$out/extension-view.schema.json"
          cp ${./dashboard-api.openapi.json} "$out/dashboard-api.openapi.json"
          cp ${./dashboard-session-draft.schema.json} "$out/dashboard-session-draft.schema.json"
          cp ${./schedule.schema.json} "$out/schedule.schema.json"
          touch "$out/.nojekyll"
          test -s "$out/index.html"
          test -s "$out/quickstart/index.html"
          test -s "$out/protocol/index.html"
          test -s "$out/tool-adapter-protocol/index.html"
          test -s "$out/protocol-v2.schema.json"
          test -s "$out/tool-adapter.schema.json"
          test -s "$out/dashboard-protocol/index.html"
          test -s "$out/dashboard-transport-security/index.html"
          test -s "$out/dashboard-authorization/index.html"
          test -s "$out/dashboard-inventory/index.html"
          test -s "$out/shadow-tui/index.html"
          test -s "$out/dashboard-ownership/index.html"
          test -s "$out/dashboard-service-api/index.html"
          test -s "$out/dash-e2e/index.html"
          test -s "$out/dashboard-api.schema.json"
          test -s "$out/extension-view.schema.json"
          test -s "$out/declarative-extension-views/index.html"
          test -s "$out/dashboard-session-tree/index.html"
          test -s "$out/dashboard-api.openapi.json"
          test -s "$out/dashboard-session-drafts/index.html"
          test -s "$out/dashboard-session-draft.schema.json"
          test -s "$out/schedules/index.html"
          test -s "$out/schedule.schema.json"
        '';
    in {
      default = package;
      pi-daemon = package;
      npm-deps = npmDeps;
      android-test-system-image = assert builtins.length androidReleaseSdk."system-images" == 1;
        builtins.head androidReleaseSdk."system-images";
      inherit pages;
    });

    apps = forAllSystems (system: {
      default = {
        type = "app";
        program = "${self.packages.${system}.default}/bin/pi-daemon";
      };
      pi-daemon = {
        type = "app";
        program = "${self.packages.${system}.pi-daemon}/bin/pi-daemon";
      };
      pi-daemon-rpc = {
        type = "app";
        program = "${self.packages.${system}.pi-daemon}/bin/pi-daemon-rpc";
      };
    });

    checks = forAllSystems (system: let
      pkgs = import nixpkgs {inherit system;};
    in
      {
        package = self.packages.${system}.default;
        pages = self.packages.${system}.pages;
        # Fails fast, and prints the exact replacement hash, when package-lock.json
        # moved without `npm run nix:deps-hash`. Fetching the dependency cache is
        # far cheaper than discovering the same mismatch through a full build.
        npm-deps-hash = import ./nix/npm-deps.nix {
          inherit pkgs;
          hash = npmDepsHash;
          name = "pi-daemon-npm-deps-oracle";
        };
        home-manager-module = import ./nix/home-manager-module-check.nix {
          inherit self pkgs;
        };
        # The ordinary Pi Droid gate is deliberately source/JVM-only: schema and
        # fixture drift must fail without fetching an Android SDK, emulator, APK,
        # AAB, signing material, or Play tooling.
        android-contract-generation =
          pkgs.runCommand "pi-droid-generated-contracts" {
            nativeBuildInputs = [pkgs.ktlint pkgs.nodejs_24];
            src = self;
          } ''
            cp -R "$src" source
            chmod -R u+w source
            cd source
            node android/build-logic/generate-protocol-models.mjs --check
            node --test test/android-contract-generation.test.mjs
            find android -type f \( -name '*.kt' -o -name '*.kts' \) -print0 \
              | xargs -0 ktlint --relative
            touch "$out"
          '';
        workflow-syntax =
          pkgs.runCommand "pi-daemon-workflow-syntax" {
            nativeBuildInputs = [pkgs.actionlint];
          } ''
            for workflow in ${./.github/workflows}/*.yml; do
              actionlint -config-file ${./.github/actionlint.yaml} "$workflow"
            done
            touch "$out"
          '';
        # Asserts what the e2e shell actually exports, rather than matching
        # `flake.nix` source text from the Node gate. Source matching is a proxy
        # for the property: it broke once when a legitimate edit changed a string
        # (bd-228b91) and it survived the alejandra reformat by luck rather than
        # construction (bd-58a7fa).
        #
        # The browsers path is read with its string context discarded on purpose.
        # Interpolating it directly would put the ~2.1 GiB Playwright closure in
        # this check's build inputs, so a check that costs nothing today would
        # fetch the whole bundle on every `nix flake check`. This asserts the
        # shell's contract, not the bundle's contents; the bundle is exercised by
        # the browser suite itself.
        e2e-shell = import ./nix/e2e-shell-check.nix {
          inherit pkgs;
          shell = self.devShells.${system}.e2e;
          webPackage = builtins.fromJSON (builtins.readFile ./web/package.json);
          justfile = ./Justfile;
        };
      }
      // pkgs.lib.optionalAttrs (system == "x86_64-linux") {
        android-test-system-image-closure = import ./nix/android-test-system-image-check.nix {
          inherit pkgs;
          image = self.packages.${system}.android-test-system-image;
          contract = androidEmulatorSystemImage;
        };
      });

    devShells = forAllSystems (system: let
      pkgs = import nixpkgs {inherit system;};
      androidReleaseSdk = androidReleaseSdkFor system;
      playwright = pkgs.playwright-driver;
      commonPackages = [
        pkgs.nodejs_24
        pkgs.git
        pkgs.jq
        pkgs.just
        pkgs.tmux
        # Android proof source contracts execute pinned Python selector/helper
        # scripts. Keep package checks and dev-shell npm tests hermetic instead
        # of relying on an ambient host interpreter.
        pkgs.python3
        # test/tls-fixture.mjs issues a certificate pair with it; node:crypto
        # cannot, so `npm test` needs it on PATH.
        pkgs.openssl
      ];
      androidComposeRuntimeLibraries = pkgs.lib.optionals pkgs.stdenv.isLinux [
        pkgs.libGL
        pkgs.fontconfig
        pkgs.freetype
        pkgs.libx11
        pkgs.libxcursor
        pkgs.libxi
        pkgs.libxrandr
        pkgs.libxrender
        pkgs.libxtst
      ];
      androidJavaHome =
        if pkgs.stdenv.isDarwin
        then "${pkgs.jdk21}/Library/Java/JavaVirtualMachines/zulu-21.jdk/Contents/Home"
        else "${pkgs.jdk21}/lib/openjdk";
    in {
      default = pkgs.mkShell {
        packages = commonPackages;
        shellHook = ''
          echo "pi-daemon dev shell: Node $(node --version), npm $(npm --version)"
        '';
      };
      # Closure publication must never depend on a mutable runner PATH or host
      # install. CI and operators enter this pinned shell for every Attic call.
      closurePublisher = pkgs.mkShell {
        packages = commonPackages ++ [pkgs.actionlint pkgs.attic-client];
      };
      # Dash browser acceptance. The npm-downloaded Chromium cannot start on
      # NixOS or other library-strict hosts, so this shell supplies the audited
      # nixpkgs browser bundle instead of ad-hoc host packages. The npm
      # @playwright/test pin must equal playwright.version; `npm run e2e:nix`
      # verifies that before launching anything.
      e2e = pkgs.mkShell {
        packages = commonPackages;
        PLAYWRIGHT_BROWSERS_PATH = "${playwright.browsers}";
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
        PI_DAEMON_PLAYWRIGHT_DRIVER_VERSION = playwright.version;
        shellHook = ''
          echo "pi-daemon dash e2e shell: Node $(node --version), Nix playwright-driver ${playwright.version}"
        '';
      };
      # Fast Android contract development uses only the pinned JVM and the
      # checksum-verified Gradle wrapper. Full Android SDK/emulator and release
      # tooling belong to nightly/manual/tag lanes, never this shell.
      android = pkgs.mkShell {
        packages =
          commonPackages
          ++ [pkgs.jdk21 pkgs.ktlint]
          ++ pkgs.lib.optionals pkgs.stdenv.isLinux [pkgs.xorg-server];
        JAVA_HOME = androidJavaHome;
        LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath androidComposeRuntimeLibraries;
        shellHook = ''
          echo "pi-droid contract shell: Java $(java -version 2>&1 | head -1), Node $(node --version)"
        '';
      };
      # Heavy Android SDK/emulator/signing/Play tooling is opt-in and absent
      # from ordinary PR/main checks. It is used only by the manual internal
      # release workflow and explicit operator runs.
      androidRelease = pkgs.mkShell {
        packages =
          commonPackages
          ++ [
            androidReleaseSdk.androidsdk
            pkgs.bundletool
            pkgs.jdk21
            pkgs.ktlint
            pkgs.python3
            pkgs.sops
            pkgs.ssh-to-age
            pkgs.unzip
          ];
        ANDROID_HOME = "${androidReleaseSdk.androidsdk}/libexec/android-sdk";
        ANDROID_SDK_ROOT = "${androidReleaseSdk.androidsdk}/libexec/android-sdk";
        JAVA_HOME = androidJavaHome;
        shellHook = ''
          echo "pi-droid release shell: Android API 36, build-tools 36.0.0, Java $(java -version 2>&1 | head -1)"
        '';
      };
    });

    formatter = forAllSystems (system: (import nixpkgs {inherit system;}).alejandra);
  };
}
