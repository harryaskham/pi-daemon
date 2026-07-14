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
        npmDepsHash = "sha256-i4L8qxTOC6vZ4mnM0Sf2DKnGApF/92QWyzjNKVfJ1jg=";
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
          runHook postInstall
        '';

        meta = {
          description = "General-purpose daemon that multiplexes on-demand Pi SDK sessions";
          homepage = "https://github.com/harryaskham/pi-daemon";
          license = pkgs.lib.licenses.mit;
          mainProgram = "pi-daemon";
          platforms = systems;
        };
      };
    in {
      default = package;
      pi-daemon = package;
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
    });

    checks = forAllSystems (system: {
      package = self.packages.${system}.default;
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
