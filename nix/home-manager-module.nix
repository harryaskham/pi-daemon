{self}: {
  config,
  lib,
  pkgs,
  options,
  ...
}: let
  cfg = config.services.pi-daemon;
  isDarwin = pkgs.stdenv.isDarwin;
  isLinux = pkgs.stdenv.isLinux;
  hasSupervisord = (options ? supervisord) && (options.supervisord ? programs);
  homeDirectory = config.home.homeDirectory;
  enabledInstances = lib.filterAttrs (_: instance: instance.enable) cfg.instances;

  instanceModule = {
    name,
    config,
    ...
  }: {
    options = {
      enable = lib.mkEnableOption "Pi Daemon instance ${name}" // {default = true;};
      configFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "${homeDirectory}/.config/pi/daemon/${name}/config.yaml";
        description = "Optional non-secret Pi Daemon YAML file. The service always passes its validated instance name; module-managed values remain CLI overrides.";
      };
      stateDir = lib.mkOption {
        type = lib.types.str;
        default = "${homeDirectory}/.local/state/pi-daemon/${name}";
        description = "Owner-private durable state directory.";
      };
      socketPath = lib.mkOption {
        type = lib.types.str;
        default = "${config.stateDir}/run/pi-daemon.sock";
        description = "Owner-only Unix control socket. Must be unique across instances.";
      };
      agentDir = lib.mkOption {
        type = lib.types.str;
        default = "${homeDirectory}/.pi/agent";
        description = "Pi SDK agent/auth directory. Configure a distinct path for a separate credential domain.";
      };
      authSeedFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "${homeDirectory}/.pi/agent/auth.json";
        description = "Optional required owner-private Pi auth.json seed. When null, a distinct agentDir seeds once from Pi's normal agent directory if that auth file exists.";
      };
      allowedRoots = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [];
        example = ["/srv/agents/project-a"];
        description = "Explicit canonical workload roots granted to this instance. At least one is required.";
      };
      environment = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = {};
        description = "Non-secret process environment for this instance. Use file-backed provider/auth options for secrets.";
      };
      extraArgs = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [];
        example = ["--max-sessions" "32" "--max-concurrent-turns" "4"];
        description = "Additional bounded serve/limit arguments. Identity, path, root, and API arguments are already module-managed and duplicate arguments fail closed.";
      };
      restartSec = lib.mkOption {
        type = lib.types.ints.positive;
        default = 5;
        description = "Delay before the native supervisor restarts a failed foreground daemon.";
      };
      stdoutLog = lib.mkOption {
        type = lib.types.str;
        default = "${config.stateDir}/pi-daemon.log";
        description = "Launchd/supervisord stdout log path.";
      };
      stderrLog = lib.mkOption {
        type = lib.types.str;
        default = "${config.stateDir}/pi-daemon.err.log";
        description = "Launchd/supervisord stderr log path.";
      };
      api = {
        enable = lib.mkEnableOption "bearer-authenticated JSON/WebSocket API";
        bind = lib.mkOption {
          type = lib.types.str;
          default = "127.0.0.1";
          description = "API bind address. Non-loopback plaintext additionally requires allowInsecureHttp.";
        };
        port = lib.mkOption {
          type = lib.types.nullOr lib.types.port;
          default = null;
          example = 7463;
          description = "API TCP port. Required when the API is enabled and must be unique across instances.";
        };
        tokenFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = lib.literalExpression "config.sops.secrets.pi-daemon-api-token.path";
          description = "Optional owner-only bearer token file. When null, the daemon generates and reuses stateDir/api-token on first launch. Token bytes never enter the Nix store or argv.";
        };
        allowInsecureHttp = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Explicitly permit a non-loopback plaintext API bind. Prefer loopback or TLS termination.";
        };
      };
    };
  };

  instanceArgs = name: instance:
    [
      "${cfg.package}/bin/pi-daemon"
      "serve"
      "--instance"
      name
    ]
    ++ lib.optionals (instance.configFile != null) [
      "--config"
      instance.configFile
    ]
    ++ [
      "--socket"
      instance.socketPath
      "--state-dir"
      instance.stateDir
      "--agent-dir"
      instance.agentDir
    ]
    ++ lib.optionals (instance.authSeedFile != null) [
      "--auth-seed-file"
      instance.authSeedFile
    ]
    ++ lib.concatMap (root: ["--allow-root" root]) instance.allowedRoots
    ++ [
      "--api-enabled"
      (
        if instance.api.enable
        then "true"
        else "false"
      )
    ]
    ++ lib.optionals instance.api.enable [
      "--api-bind"
      instance.api.bind
      "--api-port"
      (toString instance.api.port)
      "--api-allow-insecure-http"
      (
        if instance.api.allowInsecureHttp
        then "true"
        else "false"
      )
    ]
    ++ lib.optionals (instance.api.enable && instance.api.tokenFile != null) [
      "--api-token-file"
      instance.api.tokenFile
    ]
    ++ instance.extraArgs;

  command = name: instance:
    lib.concatStringsSep " " (map lib.escapeShellArg (instanceArgs name instance));

  serviceEnv = name: instance:
    {
      HOME = config.home.homeDirectory;
      USER = config.home.username;
      LOGNAME = config.home.username;
      PATH = lib.concatStringsSep ":" [
        "${cfg.package}/bin"
        "${config.home.homeDirectory}/.local/bin"
        "${config.home.homeDirectory}/.nix-profile/bin"
        "/run/current-system/sw/bin"
        "/nix/var/nix/profiles/default/bin"
        "/usr/local/bin"
        "/opt/homebrew/bin"
        "/usr/bin"
        "/bin"
      ];
      PI_DAEMON_INSTANCE = name;
      PI_DAEMON_SOCKET = instance.socketPath;
      PI_DAEMON_STATE_DIR = instance.stateDir;
    }
    // instance.environment;

  serviceName = name: "pi-daemon-${name}";
  enabledList = lib.attrValues enabledInstances;
  enabledApiInstances = lib.filter (instance: instance.api.enable) enabledList;
  enabledConfigInstances = lib.filter (instance: instance.configFile != null) enabledList;
  effectiveApiTokenFile = instance:
    if instance.api.tokenFile == null
    then "${instance.stateDir}/api-token"
    else instance.api.tokenFile;
  unique = values: builtins.length values == builtins.length (lib.unique values);
  protectedExtraArgs = [
    "--config"
    "--instance"
    "--socket"
    "--state-dir"
    "--agent-dir"
    "--auth-seed-file"
    "--allow-root"
    "--api-enabled"
    "--api-bind"
    "--api-port"
    "--api-token-file"
    "--api-token-fd"
    "--api-allow-insecure-http"
  ];
in {
  options.services.pi-daemon = {
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-daemon;
      defaultText = lib.literalExpression "inputs.pi-daemon.packages.\${pkgs.system}.pi-daemon";
      description = "Pi Daemon package installed and executed by every managed instance.";
    };
    instances = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule instanceModule);
      default = {};
      example = lib.literalExpression ''        {
                work = {
                  stateDir = "\${config.xdg.stateHome}/pi-daemon-work";
                  socketPath = "\${config.xdg.runtimeDir}/pi-daemon-work.sock";
                  allowedRoots = [ "/srv/work" ];
                  api = {
                    enable = true;
                    port = 7463;
                    tokenFile = config.sops.secrets.pi-daemon-work.path;
                  };
                };
              }'';
      description = "Independently named Pi Daemon service instances with collision-free paths, ports, and native service identities.";
    };
  };

  config = lib.mkIf (enabledInstances != {}) (lib.mkMerge [
    {
      assertions =
        (lib.mapAttrsToList (name: instance: {
            assertion = builtins.match "^[A-Za-z0-9][A-Za-z0-9-]{0,62}$" name != null;
            message = "services.pi-daemon.instances.${name}: instance name must be 1-63 alphanumeric/hyphen characters";
          })
          enabledInstances)
        ++ (lib.mapAttrsToList (name: instance: {
            assertion = instance.allowedRoots != [];
            message = "services.pi-daemon.instances.${name}.allowedRoots must contain at least one explicit workload root";
          })
          enabledInstances)
        ++ (lib.mapAttrsToList (name: instance: {
            assertion = !instance.api.enable || instance.api.port != null;
            message = "services.pi-daemon.instances.${name}: api.port is required when api.enable is true";
          })
          enabledInstances)
        ++ (lib.mapAttrsToList (name: instance: {
            assertion = lib.all (arg: !(lib.elem arg protectedExtraArgs)) instance.extraArgs;
            message = "services.pi-daemon.instances.${name}.extraArgs must not override module-managed identity/path/root/API arguments";
          })
          enabledInstances)
        ++ [
          {
            assertion = unique (map (instance: instance.configFile) enabledConfigInstances);
            message = "enabled Pi Daemon instances must use unique explicit configFile values";
          }
          {
            assertion = unique (map (instance: instance.stateDir) enabledList);
            message = "enabled Pi Daemon instances must use unique stateDir values";
          }
          {
            assertion = unique (map (instance: instance.socketPath) enabledList);
            message = "enabled Pi Daemon instances must use unique socketPath values";
          }
          {
            assertion = unique (map (instance: instance.stdoutLog) enabledList);
            message = "enabled Pi Daemon instances must use unique stdoutLog values";
          }
          {
            assertion = unique (map (instance: instance.stderrLog) enabledList);
            message = "enabled Pi Daemon instances must use unique stderrLog values";
          }
          {
            assertion = unique (map (instance: instance.api.port) enabledApiInstances);
            message = "enabled Pi Daemon APIs must use unique ports";
          }
          {
            assertion = unique (map effectiveApiTokenFile enabledApiInstances);
            message = "enabled Pi Daemon APIs must use unique effective token files";
          }
        ];

      home.packages = [cfg.package];
      home.activation = lib.mapAttrs' (name: instance:
        lib.nameValuePair "piDaemon-${name}-directories" (
          lib.hm.dag.entryAfter ["writeBoundary"] ''
            run install -d -m 700 ${lib.escapeShellArg instance.stateDir}
            run install -d -m 700 ${lib.escapeShellArg instance.agentDir}
            run install -d -m 700 ${lib.escapeShellArg (builtins.dirOf instance.socketPath)}
            run install -d -m 700 ${lib.escapeShellArg (builtins.dirOf instance.stdoutLog)}
            run install -d -m 700 ${lib.escapeShellArg (builtins.dirOf instance.stderrLog)}
          ''
        ))
      enabledInstances;
    }

    (lib.mkIf (isLinux && !hasSupervisord) {
      systemd.user.services = lib.mapAttrs' (name: instance:
        lib.nameValuePair (serviceName name) {
          Unit = {
            Description = "Pi Daemon instance ${name}";
            Documentation = "https://github.com/harryaskham/pi-daemon";
            After = ["default.target"];
          };
          Service = {
            Type = "simple";
            Environment = lib.mapAttrsToList (key: value: "${key}=${value}") (serviceEnv name instance);
            ExecStart = command name instance;
            Restart = "always";
            RestartSec = instance.restartSec;
            UMask = "0077";
            StandardOutput = "journal";
            StandardError = "journal";
            SyslogIdentifier = serviceName name;
          };
          Install.WantedBy = ["default.target"];
        })
      enabledInstances;
    })

    (lib.mkIf isDarwin {
      launchd.agents = lib.mapAttrs' (name: instance:
        lib.nameValuePair (serviceName name) {
          enable = true;
          config = {
            Label = "com.pi-daemon.${name}";
            ProgramArguments = instanceArgs name instance;
            EnvironmentVariables = serviceEnv name instance;
            RunAtLoad = true;
            KeepAlive = true;
            ThrottleInterval = instance.restartSec;
            ProcessType = "Background";
            StandardOutPath = instance.stdoutLog;
            StandardErrorPath = instance.stderrLog;
          };
        })
      enabledInstances;
    })

    (lib.mkIf isLinux (lib.optionalAttrs hasSupervisord {
      supervisord.programs = lib.mapAttrs' (name: instance:
        lib.nameValuePair (serviceName name) {
          command = command name instance;
          environment = lib.concatStringsSep "," (
            lib.mapAttrsToList (key: value: "${key}=\"${value}\"") (serviceEnv name instance)
          );
          autorestart = "true";
          startsecs = 0;
          stdout_logfile = instance.stdoutLog;
          stderr_logfile = instance.stderrLog;
        })
      enabledInstances;
    }))
  ]);
}
