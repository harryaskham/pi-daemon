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

    # Single source of truth for the pinned npm dependency cache. Refresh this
    # block with `npm run nix:deps-hash` after any package-lock.json change; the
    # `npm-deps-lock` marker is a plain staleness signal that lets CI flag a
    # stale pin without needing Nix on the runner.
    # npm-deps-lock: sha256-w7xo7p97dsxQZR+u18telAp9rn1tdHxLz5HXoQcdblA=
    npmDepsHash = "sha256-zby5nWPsJBjSEs3quJIZla4YsMEhlxN+dKwHrOeh8Rg=";
  in {
    homeManagerModules.pi-daemon = import ./nix/home-manager-module.nix {inherit self;};
    homeManagerModules.default = self.homeManagerModules.pi-daemon;

    packages = forAllSystems (system: let
      pkgs = import nixpkgs {inherit system;};
      npmDeps = import ./nix/npm-deps.nix {
        inherit pkgs;
        hash = npmDepsHash;
      };
      package = pkgs.buildNpmPackage {
        pname = "pi-daemon";
        version = "0.3.0";
        src = ./.;

        nodejs = pkgs.nodejs_24;
        inherit npmDeps;
        npmDepsFetcherVersion = 2;
        nativeBuildInputs = [pkgs.makeWrapper pkgs.openssl];

        npmBuildScript = "build";
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
          "$out/bin/pi-daemon" version | grep -Fx 0.3.0
          "$out/bin/pi-daemon-rpc" --version | grep -Fx 0.3.0
        '';

        meta = {
          description = "General-purpose daemon that multiplexes on-demand Pi SDK sessions";
          homepage = "https://github.com/harryaskham/pi-daemon";
          license = pkgs.lib.licenses.mit;
          mainProgram = "pi-daemon";
          platforms = systems;
        };
      };
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
    in {
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
    });

    devShells = forAllSystems (system: let
      pkgs = import nixpkgs {inherit system;};
      playwright = pkgs.playwright-driver;
      commonPackages = [
        pkgs.nodejs_24
        pkgs.git
        pkgs.jq
        pkgs.just
        pkgs.tmux
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
        JAVA_HOME = "${pkgs.jdk21}/lib/openjdk";
        LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath androidComposeRuntimeLibraries;
        shellHook = ''
          echo "pi-droid contract shell: Java $(java -version 2>&1 | head -1), Node $(node --version)"
        '';
      };
    });

    formatter = forAllSystems (system: (import nixpkgs {inherit system;}).alejandra);
  };
}
