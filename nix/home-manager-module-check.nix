{
  self,
  pkgs,
}: let
  lib = pkgs.lib;
  baseStubs = {lib, ...}: {
    options = {
      home.homeDirectory = lib.mkOption {
        type = lib.types.str;
        default = "/home/tester";
      };
      home.username = lib.mkOption {
        type = lib.types.str;
        default = "tester";
      };
      home.packages = lib.mkOption {
        type = lib.types.listOf lib.types.package;
        default = [];
      };
      home.activation = lib.mkOption {
        type = lib.types.attrsOf lib.types.anything;
        default = {};
      };
      assertions = lib.mkOption {
        type = lib.types.listOf lib.types.anything;
        default = [];
      };
      systemd.user.services = lib.mkOption {
        type = lib.types.attrsOf lib.types.anything;
        default = {};
      };
      launchd.agents = lib.mkOption {
        type = lib.types.attrsOf lib.types.anything;
        default = {};
      };
    };
    config._module.args.lib = lib // {hm.dag.entryAfter = _deps: value: value;};
  };
  supervisordStub = {lib, ...}: {
    options.supervisord.programs = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = {};
    };
  };
  testPackage = pkgs.writeShellScriptBin "pi-daemon" ''
    exit 0
  '';
  instanceConfig = {
    services.pi-daemon.package = testPackage;
    services.pi-daemon.mutableRuntime.enable = true;
    services.pi-daemon.instances = {
      alpha = {
        configFile = "/home/tester/.config/pi/daemon/alpha/config.yaml";
        stateDir = "/home/tester/.state/pi-alpha";
        socketPath = "/home/tester/.run/pi-alpha.sock";
        agentDir = "/home/tester/.pi-alpha";
        authSeedFile = "/home/tester/.pi/agent/auth.json";
        allowedRoots = ["/srv/alpha" "/srv/shared"];
        allowAuthorityRootOverlap = true;
        dashboardAuth.identities = [
          {
            identityId = "alpha-owner";
            globalRole = "administrator";
            displayName = "Alpha owner";
            credentialFile = "/run/secrets/pi-alpha-owner";
          }
          {
            identityId = "alpha-member";
            globalRole = "member";
            credentialFile = "/run/secrets/pi-alpha-member";
          }
        ];
        api = {
          enable = true;
          bind = "127.0.0.1";
          port = 17463;
          tokenFile = "/run/secrets/pi-alpha-token";
        };
        dedicatedWeb = {
          enable = true;
          stateDir = "/home/tester/.state/pi-alpha-web";
          port = 17465;
          publicOrigin = "https://dash.example.test";
          trustProxyHeaders = true;
          tls = {
            certFile = "/run/secrets/pi-alpha-dash-cert";
            keyFile = "/run/secrets/pi-alpha-dash-key";
            reloadIntervalMs = 15000;
          };
          stdoutLog = "/home/tester/.state/pi-alpha-web/stdout.log";
          stderrLog = "/home/tester/.state/pi-alpha-web/stderr.log";
        };
        extraArgs = ["--max-sessions" "16"];
      };
      beta = {
        stateDir = "/home/tester/.state/pi-beta";
        socketPath = "/home/tester/.run/pi-beta.sock";
        agentDir = "/home/tester/.pi-beta";
        allowedRoots = ["/srv/beta"];
        environment.PI_DAEMON_TEST = "beta";
        api = {
          enable = true;
          port = 17464;
        };
      };
    };
  };
  eval = lib.evalModules {
    specialArgs = {inherit pkgs;};
    modules = [
      baseStubs
      self.homeManagerModules.pi-daemon
      instanceConfig
    ];
  };
  evalCollision = lib.evalModules {
    specialArgs = {inherit pkgs;};
    modules = [
      baseStubs
      self.homeManagerModules.pi-daemon
      {
        services.pi-daemon.package = testPackage;
        services.pi-daemon.instances = {
          one = {
            allowedRoots = ["/srv/one"];
            socketPath = "/tmp/shared.sock";
          };
          two = {
            allowedRoots = ["/srv/two"];
            socketPath = "/tmp/shared.sock";
          };
        };
      }
    ];
  };
  evalConfigCollision = lib.evalModules {
    specialArgs = {inherit pkgs;};
    modules = [
      baseStubs
      self.homeManagerModules.pi-daemon
      {
        services.pi-daemon.package = testPackage;
        services.pi-daemon.instances = {
          one = {
            allowedRoots = ["/srv/one"];
            configFile = "/home/tester/.config/pi/daemon/shared/config.yaml";
          };
          two = {
            allowedRoots = ["/srv/two"];
            configFile = "/home/tester/.config/pi/daemon/shared/config.yaml";
          };
        };
      }
    ];
  };
  evalPortCollision = lib.evalModules {
    specialArgs = {inherit pkgs;};
    modules = [
      baseStubs
      self.homeManagerModules.pi-daemon
      {
        services.pi-daemon.package = testPackage;
        services.pi-daemon.instances = {
          one = {
            allowedRoots = ["/srv/one"];
            api = {
              enable = true;
              port = 17463;
              tokenFile = "/run/secrets/one";
            };
          };
          two = {
            allowedRoots = ["/srv/two"];
            api = {
              enable = true;
              port = 17463;
              tokenFile = "/run/secrets/two";
            };
          };
        };
      }
    ];
  };
  evalWebPortCollision = lib.evalModules {
    specialArgs = {inherit pkgs;};
    modules = [
      baseStubs
      self.homeManagerModules.pi-daemon
      {
        services.pi-daemon.package = testPackage;
        services.pi-daemon.instances.one = {
          allowedRoots = ["/srv/one"];
          api = { enable = true; port = 17463; };
          dedicatedWeb = { enable = true; port = 17463; };
        };
      }
    ];
  };
  evalTokenCollision = lib.evalModules {
    specialArgs = {inherit pkgs;};
    modules = [
      baseStubs
      self.homeManagerModules.pi-daemon
      {
        services.pi-daemon.package = testPackage;
        services.pi-daemon.instances = {
          one = {
            allowedRoots = ["/srv/one"];
            api = {
              enable = true;
              port = 17463;
              tokenFile = "/run/secrets/shared";
            };
          };
          two = {
            allowedRoots = ["/srv/two"];
            api = {
              enable = true;
              port = 17464;
              tokenFile = "/run/secrets/shared";
            };
          };
        };
      }
    ];
  };
  evalDashboardIdentityInvalid = lib.evalModules {
    specialArgs = {inherit pkgs;};
    modules = [
      baseStubs
      self.homeManagerModules.pi-daemon
      {
        services.pi-daemon.package = testPackage;
        services.pi-daemon.instances.one = {
          allowedRoots = ["/srv/one"];
          dashboardAuth.identities = [
            {
              identityId = "member-only";
              globalRole = "member";
              credentialFile = "/run/secrets/member-only";
            }
          ];
        };
      }
    ];
  };
  evalSupervisord = lib.evalModules {
    specialArgs = {inherit pkgs;};
    modules = [
      baseStubs
      supervisordStub
      self.homeManagerModules.pi-daemon
      instanceConfig
    ];
  };
  assertionsOk = builtins.all (entry: entry.assertion) eval.config.assertions;
  collisionDetected = !(builtins.all (entry: entry.assertion) evalCollision.config.assertions);
  configCollisionDetected = !(builtins.all (entry: entry.assertion) evalConfigCollision.config.assertions);
  portCollisionDetected = !(builtins.all (entry: entry.assertion) evalPortCollision.config.assertions);
  tokenCollisionDetected = !(builtins.all (entry: entry.assertion) evalTokenCollision.config.assertions);
  webPortCollisionDetected = !(builtins.all (entry: entry.assertion) evalWebPortCollision.config.assertions);
  dashboardIdentityInvalidDetected = !(builtins.all (entry: entry.assertion) evalDashboardIdentityInvalid.config.assertions);
  normalServices =
    if pkgs.stdenv.isDarwin
    then eval.config.launchd.agents
    else eval.config.systemd.user.services;
  normalAlpha = normalServices."pi-daemon-alpha";
  normalAlphaWeb = normalServices."pi-daemon-web-alpha";
  normalBeta = normalServices."pi-daemon-beta";
  normalAlphaCommand =
    if pkgs.stdenv.isDarwin
    then builtins.concatStringsSep " " normalAlpha.config.ProgramArguments
    else normalAlpha.Service.ExecStart;
  normalAlphaIdentity =
    if pkgs.stdenv.isDarwin
    then normalAlpha.config.Label
    else "pi-daemon-alpha";
  normalAlphaExecutable =
    if pkgs.stdenv.isDarwin
    then builtins.head normalAlpha.config.ProgramArguments
    else builtins.head (lib.splitString " " normalAlpha.Service.ExecStart);
  normalAlphaWebCommand =
    if pkgs.stdenv.isDarwin
    then builtins.concatStringsSep " " normalAlphaWeb.config.ProgramArguments
    else normalAlphaWeb.Service.ExecStart;
  normalBetaCommand =
    if pkgs.stdenv.isDarwin
    then builtins.concatStringsSep " " normalBeta.config.ProgramArguments
    else normalBeta.Service.ExecStart;
  normalBetaEnvironment =
    if pkgs.stdenv.isDarwin
    then normalBeta.config.EnvironmentVariables
    else
      builtins.listToAttrs (map (entry: let
          parts = lib.splitString "=" entry;
        in {
          name = builtins.unsafeDiscardStringContext (builtins.head parts);
          value = lib.concatStringsSep "=" (builtins.tail parts);
        })
        normalBeta.Service.Environment);
  supervisorAlpha =
    if pkgs.stdenv.isLinux
    then evalSupervisord.config.supervisord.programs."pi-daemon-alpha"
    else null;
  supervisorAlphaWeb =
    if pkgs.stdenv.isLinux
    then evalSupervisord.config.supervisord.programs."pi-daemon-web-alpha"
    else null;
in
  assert assertionsOk;
  assert collisionDetected;
  assert configCollisionDetected;
  assert portCollisionDetected;
  assert tokenCollisionDetected;
  assert webPortCollisionDetected;
  assert dashboardIdentityInvalidDetected;
  assert builtins.isString normalAlphaExecutable;
    pkgs.runCommand "pi-daemon-home-manager-module-check" {} ''
      test ${lib.escapeShellArg (toString (builtins.length eval.config.home.packages))} = 1
      test ${lib.escapeShellArg normalAlphaIdentity} = ${lib.escapeShellArg (
        if pkgs.stdenv.isDarwin
        then "com.pi-daemon.alpha"
        else "pi-daemon-alpha"
      )}
      test ${lib.escapeShellArg normalBetaEnvironment.PI_DAEMON_INSTANCE} = beta
      test ${lib.escapeShellArg normalBetaEnvironment.PI_DAEMON_SOCKET} = /home/tester/.run/pi-beta.sock
      printf '%s\n' ${lib.escapeShellArg normalBetaEnvironment.PATH} | grep -F -- ${lib.escapeShellArg "${pkgs.nodejs}/bin"}
      grep -F -- '/home/tester/.local/bin/pi-daemon' ${lib.escapeShellArg normalAlphaExecutable}
      grep -F -- ${lib.escapeShellArg "${testPackage}/bin/pi-daemon"} ${lib.escapeShellArg normalAlphaExecutable}
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '--instance'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- 'alpha'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '--config'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '/home/tester/.config/pi/daemon/alpha/config.yaml'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '--socket'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '/home/tester/.run/pi-alpha.sock'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '--auth-seed-file'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '/home/tester/.pi/agent/auth.json'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '--allow-root'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '--allow-authority-root-overlap true'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '/srv/shared'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '--api-enabled true'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '--api-port'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '17463'
      printf '%s\n' ${lib.escapeShellArg normalBetaCommand} | grep -F -- '17464'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- 'web'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- '--api-url'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- 'http://127.0.0.1:17463'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- '--api-token-file'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- '/run/secrets/pi-alpha-token'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- '--web-identity-provider-file'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- 'pi-daemon-dashboard-identities-alpha.json'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- '--web-port'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- '17465'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- '--public-origin'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- 'https://dash.example.test'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- '--trust-proxy-headers true'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- '--tls-cert-file'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- '/run/secrets/pi-alpha-dash-cert'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- '--tls-key-file'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- '/run/secrets/pi-alpha-dash-key'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- '--tls-reload-ms 15000'
      printf '%s\n' ${lib.escapeShellArg normalAlphaWebCommand} | grep -F -- '/home/tester/.state/pi-alpha-web'
      if printf '%s\n' ${lib.escapeShellArg normalBetaCommand} | grep -F -- '--api-token-file'; then
        echo 'default managed bearer must not enter argv' >&2
        exit 1
      fi
      ${lib.optionalString pkgs.stdenv.isLinux ''
        printf '%s\n' ${lib.escapeShellArg supervisorAlpha.command} | grep -F -- '/home/tester/.run/pi-alpha.sock'
        test ${lib.escapeShellArg supervisorAlpha.autorestart} = true
        printf '%s\n' ${lib.escapeShellArg supervisorAlphaWeb.command} | grep -F -- '17465'
        test ${lib.escapeShellArg supervisorAlphaWeb.autorestart} = true
      ''}
      touch "$out"
    ''
