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
    services.pi-daemon.instances = {
      alpha = {
        stateDir = "/home/tester/.state/pi-alpha";
        socketPath = "/home/tester/.run/pi-alpha.sock";
        agentDir = "/home/tester/.pi-alpha";
        authSeedFile = "/home/tester/.pi/agent/auth.json";
        allowedRoots = ["/srv/alpha" "/srv/shared"];
        api = {
          enable = true;
          bind = "127.0.0.1";
          port = 17463;
          tokenFile = "/run/secrets/pi-alpha-token";
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
  portCollisionDetected = !(builtins.all (entry: entry.assertion) evalPortCollision.config.assertions);
  tokenCollisionDetected = !(builtins.all (entry: entry.assertion) evalTokenCollision.config.assertions);
  normalServices =
    if pkgs.stdenv.isDarwin
    then eval.config.launchd.agents
    else eval.config.systemd.user.services;
  normalAlpha = normalServices."pi-daemon-alpha";
  normalBeta = normalServices."pi-daemon-beta";
  normalAlphaCommand =
    if pkgs.stdenv.isDarwin
    then builtins.concatStringsSep " " normalAlpha.config.ProgramArguments
    else normalAlpha.Service.ExecStart;
  normalAlphaIdentity =
    if pkgs.stdenv.isDarwin
    then normalAlpha.config.Label
    else "pi-daemon-alpha";
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
in
  assert assertionsOk;
  assert collisionDetected;
  assert portCollisionDetected;
  assert tokenCollisionDetected;
    pkgs.runCommand "pi-daemon-home-manager-module-check" {} ''
      test ${lib.escapeShellArg (toString (builtins.length eval.config.home.packages))} = 1
      test ${lib.escapeShellArg normalAlphaIdentity} = ${lib.escapeShellArg (
        if pkgs.stdenv.isDarwin
        then "com.pi-daemon.alpha"
        else "pi-daemon-alpha"
      )}
      test ${lib.escapeShellArg normalBetaEnvironment.PI_DAEMON_INSTANCE} = beta
      test ${lib.escapeShellArg normalBetaEnvironment.PI_DAEMON_SOCKET} = /home/tester/.run/pi-beta.sock
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '--socket'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '/home/tester/.run/pi-alpha.sock'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '--auth-seed-file'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '/home/tester/.pi/agent/auth.json'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '--allow-root'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '/srv/shared'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '--api-port'
      printf '%s\n' ${lib.escapeShellArg normalAlphaCommand} | grep -F -- '17463'
      printf '%s\n' ${lib.escapeShellArg normalBetaCommand} | grep -F -- '17464'
      if printf '%s\n' ${lib.escapeShellArg normalBetaCommand} | grep -F -- '--api-token-file'; then
        echo 'default managed bearer must not enter argv' >&2
        exit 1
      fi
      ${lib.optionalString pkgs.stdenv.isLinux ''
        printf '%s\n' ${lib.escapeShellArg supervisorAlpha.command} | grep -F -- '/home/tester/.run/pi-alpha.sock'
        test ${lib.escapeShellArg supervisorAlpha.autorestart} = true
      ''}
      touch "$out"
    ''
