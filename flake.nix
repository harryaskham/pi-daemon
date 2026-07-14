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
  in {
    packages = forAllSystems (system: let
      pkgs = import nixpkgs {inherit system;};
      package = pkgs.buildNpmPackage {
        pname = "pi-daemon";
        version = "0.1.0";
        src = ./.;

        nodejs = pkgs.nodejs_24;
        npmDepsHash = "sha256-Voqa2MPPpUV7xL1UspflRfnneirSUq3DIfV7lZBMbSY=";
        npmDepsFetcherVersion = 2;
        nativeBuildInputs = [pkgs.makeWrapper];

        npmBuildScript = "build";
        doCheck = true;
        checkPhase = ''
          runHook preCheck
          npm test
          runHook postCheck
        '';

        installPhase = ''
          runHook preInstall
          npm prune --omit=dev --ignore-scripts
          packageRoot="$out/lib/node_modules/@harryaskham/pi-daemon"
          mkdir -p "$packageRoot" "$out/bin"
          cp -R dist node_modules package.json CHANGELOG.md README.md SECURITY.md LICENSE \
            protocol.schema.json session-api.schema.json session-api.openapi.json "$packageRoot/"
          makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/pi-daemon" \
            --add-flags "$packageRoot/dist/cli.js"
          makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/pi-daemon-rpc" \
            --add-flags "$packageRoot/dist/rpc-stdio-cli.js"
          runHook postInstall
        '';
        doInstallCheck = true;
        installCheckPhase = ''
          "$out/bin/pi-daemon" version | grep -Fx 0.1.0
          "$out/bin/pi-daemon-rpc" --version | grep -Fx 0.1.0
        '';

        meta = {
          description = "General-purpose daemon that multiplexes on-demand Pi SDK sessions";
          homepage = "https://github.com/harryaskham/pi-daemon";
          license = pkgs.lib.licenses.mit;
          mainProgram = "pi-daemon";
          platforms = systems;
        };
      };
      pages = pkgs.runCommand "pi-daemon-pages" {
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
        cp ${./session-api.schema.json} "$out/session-api.schema.json"
        cp ${./session-api.openapi.json} "$out/session-api.openapi.json"
        touch "$out/.nojekyll"
        test -s "$out/index.html"
        test -s "$out/protocol/index.html"
      '';
    in {
      default = package;
      pi-daemon = package;
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

    checks = forAllSystems (system: {
      package = self.packages.${system}.default;
      pages = self.packages.${system}.pages;
    });

    devShells = forAllSystems (system: let
      pkgs = import nixpkgs {inherit system;};
    in {
      default = pkgs.mkShell {
        packages = [
          pkgs.nodejs_24
          pkgs.git
          pkgs.jq
        ];
        shellHook = ''
          echo "pi-daemon dev shell: Node $(node --version), npm $(npm --version)"
        '';
      };
    });

    formatter = forAllSystems (system: (import nixpkgs {inherit system;}).alejandra);
  };
}
