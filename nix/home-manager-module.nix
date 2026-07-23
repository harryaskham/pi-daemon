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
  dashboardIdentityModule = {config, ...}: {
    options = {
      identityId = lib.mkOption {
        type = lib.types.strMatching "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
        description = "Stable Dashboard identity ID.";
      };
      globalRole = lib.mkOption {
        type = lib.types.enum ["administrator" "member"];
        default = "member";
        description = "Global Dashboard role; resource roles remain in the owner-private policy ledger.";
      };
      displayName = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Optional non-secret accessible display name.";
      };
      credentialFile = lib.mkOption {
        type = lib.types.str;
        example = lib.literalExpression "config.sops.secrets.pi-daemon-dash-alice.path";
        description = "Owner-only runtime credential path. Credential bytes never enter Nix values, the store, argv, status, or logs.";
      };
    };
  };
  runtimeExecutable =
    if cfg.mutableRuntime.enable
    then
      toString (pkgs.writeShellScript "pi-daemon-runtime" ''
        candidate=${lib.escapeShellArg cfg.mutableRuntime.binaryPath}
        if [[ -x "$candidate" ]] && [[ ! "$candidate" -ef "$0" ]]; then
          exec "$candidate" "$@"
        fi
        exec ${lib.escapeShellArg "${cfg.package}/bin/pi-daemon"} "$@"
      '')
    else "${cfg.package}/bin/pi-daemon";

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
      allowAuthorityRootOverlap = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "High-trust opt-in allowing a logical cwd to contain daemon state, session storage, or Pi credential roots. This permits home-directory Pi sessions but lets any enabled session tools reach those paths.";
      };
      environment = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = {};
        description = "Non-secret process environment for this instance. Use file-backed provider/auth options for secrets.";
      };
      dashboardAuth = {
        identityProviderFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "/run/pi-daemon/dashboard-identities.yaml";
          description = "Strict non-secret static-provider YAML/JSON path. The document may contain only identity metadata and credential file paths/descriptors.";
        };
        identities = lib.mkOption {
          type = lib.types.listOf (lib.types.submodule dashboardIdentityModule);
          default = [];
          description = "Static Dashboard identities. Home Manager emits only metadata and credential paths to the Nix store; credential bytes remain in owner-only runtime files.";
        };
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
      dedicatedWeb = {
        enable = lib.mkEnableOption "dedicated Pi Daemon Dash process";
        stateDir = lib.mkOption {
          type = lib.types.str;
          default = "${homeDirectory}/.local/state/pi-daemon-web/${name}";
          description = "Owner-private dedicated browser state, sessions, workspaces, and web credential directory.";
        };
        bind = lib.mkOption {
          type = lib.types.str;
          default = "127.0.0.1";
          description = "Dedicated Dash loopback bind address.";
        };
        port = lib.mkOption {
          type = lib.types.nullOr lib.types.port;
          default = null;
          example = 7465;
          description = "Dedicated Dash TCP port; required when enabled and unique across API/Dash services.";
        };
        publicOrigin = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "https://dash.example.test";
          description = "Optional exact browser-visible origin. Required for native TLS; HTTPS is required for remote exposure unless allowInsecurePublicOrigin is explicitly enabled.";
        };
        allowInsecurePublicOrigin = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Explicit development-only opt-in for a non-loopback plaintext browser origin.";
        };
        trustProxyHeaders = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Verify exact X-Forwarded-Host/Proto/Port values from a loopback reverse proxy. Forwarded headers are rejected by default and never define authority.";
        };
        tls = {
          certFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            example = lib.literalExpression "config.sops.secrets.pi-daemon-dash-cert.path";
            description = "Owner-controlled PEM certificate path for native HTTPS. Certificate bytes never enter argv, the Nix store, status, or logs.";
          };
          keyFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            example = lib.literalExpression "config.sops.secrets.pi-daemon-dash-key.path";
            description = "Owner-only PEM private-key path for native HTTPS. Key bytes never enter argv, the Nix store, status, or logs.";
          };
          reloadIntervalMs = lib.mkOption {
            type = lib.types.ints.positive;
            default = 30000;
            description = "Polling interval for atomic native TLS certificate/key rotation.";
          };
        };
        allowInsecureHttp = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Permit the dedicated backend client to send its bearer to a non-loopback plaintext API.";
        };
        stdoutLog = lib.mkOption {
          type = lib.types.str;
          default = "${config.stateDir}/pi-daemon-web.log";
          description = "Dedicated Dash launchd/supervisord stdout log path.";
        };
        stderrLog = lib.mkOption {
          type = lib.types.str;
          default = "${config.stateDir}/pi-daemon-web.err.log";
          description = "Dedicated Dash launchd/supervisord stderr log path.";
        };
      };
    };
  };

  generatedDashboardIdentityProviderFile = name: instance:
    if instance.dashboardAuth.identities == []
    then null
    else
      pkgs.writeText "pi-daemon-dashboard-identities-${name}.json" (builtins.toJSON {
        type = "static";
        identities = map (identity:
          {
            inherit (identity) identityId globalRole credentialFile;
          }
          // lib.optionalAttrs (identity.displayName != null) {
            inherit (identity) displayName;
          })
        instance.dashboardAuth.identities;
      });
  effectiveDashboardIdentityProviderFile = name: instance:
    if instance.dashboardAuth.identityProviderFile != null
    then instance.dashboardAuth.identityProviderFile
    else generatedDashboardIdentityProviderFile name instance;

  instanceArgs = name: instance:
    [
      runtimeExecutable
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
    ++ lib.optionals (
      !instance.dedicatedWeb.enable
      && effectiveDashboardIdentityProviderFile name instance != null
    ) [
      "--web-identity-provider-file"
      (effectiveDashboardIdentityProviderFile name instance)
    ]
    ++ lib.concatMap (root: ["--allow-root" root]) instance.allowedRoots
    ++ [
      "--allow-authority-root-overlap"
      (if instance.allowAuthorityRootOverlap then "true" else "false")
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

  apiClientHost = instance:
    if instance.api.bind == "0.0.0.0"
    then "127.0.0.1"
    else if instance.api.bind == "::"
    then "::1"
    else instance.api.bind;
  apiClientUrl = instance: let
    host = apiClientHost instance;
    renderedHost = if lib.hasInfix ":" host then "[${host}]" else host;
  in "http://${renderedHost}:${toString instance.api.port}";
  dedicatedWebArgs = name: instance:
    [
      runtimeExecutable
      "web"
      "--instance"
      name
    ]
    ++ lib.optionals (instance.configFile != null) [
      "--config"
      instance.configFile
    ]
    ++ [
      "--api-url"
      (apiClientUrl instance)
      "--api-token-file"
      (effectiveApiTokenFile instance)
      "--web-state-dir"
      instance.dedicatedWeb.stateDir
      "--web-bind"
      instance.dedicatedWeb.bind
      "--web-port"
      (toString instance.dedicatedWeb.port)
      "--api-allow-insecure-http"
      (if instance.dedicatedWeb.allowInsecureHttp then "true" else "false")
      "--web-allow-insecure-http"
      (if instance.dedicatedWeb.allowInsecurePublicOrigin then "true" else "false")
      "--trust-proxy-headers"
      (if instance.dedicatedWeb.trustProxyHeaders then "true" else "false")
    ]
    ++ lib.optionals (instance.dedicatedWeb.publicOrigin != null) [
      "--public-origin"
      instance.dedicatedWeb.publicOrigin
    ]
    ++ lib.optionals (effectiveDashboardIdentityProviderFile name instance != null) [
      "--web-identity-provider-file"
      (effectiveDashboardIdentityProviderFile name instance)
    ]
    ++ lib.optionals (instance.dedicatedWeb.tls.certFile != null) [
      "--tls-cert-file"
      instance.dedicatedWeb.tls.certFile
      "--tls-key-file"
      instance.dedicatedWeb.tls.keyFile
      "--tls-reload-ms"
      (toString instance.dedicatedWeb.tls.reloadIntervalMs)
    ];
  dedicatedWebCommand = name: instance:
    lib.concatStringsSep " " (map lib.escapeShellArg (dedicatedWebArgs name instance));

  serviceEnv = name: instance:
    {
      HOME = config.home.homeDirectory;
      USER = config.home.username;
      LOGNAME = config.home.username;
      PATH = lib.concatStringsSep ":" [
        "${cfg.package}/bin"
        "${pkgs.nodejs}/bin"
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
  webServiceName = name: "pi-daemon-web-${name}";
  dedicatedWebEnv = name: instance:
    (serviceEnv name instance)
    // {
      PI_DAEMON_WEB_STATE_DIR = instance.dedicatedWeb.stateDir;
    };
  enabledDedicatedWebInstances = lib.filterAttrs (_: instance: instance.dedicatedWeb.enable) enabledInstances;
  enabledList = lib.attrValues enabledInstances;
  enabledApiInstances = lib.filter (instance: instance.api.enable) enabledList;
  enabledDedicatedWebList = lib.attrValues enabledDedicatedWebInstances;
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
    "--allow-authority-root-overlap"
    "--api-enabled"
    "--api-bind"
    "--api-port"
    "--api-token-file"
    "--api-token-fd"
    "--api-allow-insecure-http"
    "--web-identity-provider-file"
  ];
in {
  options.services.pi-daemon = {
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-daemon;
      defaultText = lib.literalExpression "inputs.pi-daemon.packages.\${pkgs.system}.pi-daemon";
      description = "Pi Daemon package installed and executed by every managed instance.";
    };
    mutableRuntime = {
      enable = lib.mkEnableOption "owner-local atomic Pi Daemon updates with immutable package fallback";
      binaryPath = lib.mkOption {
        type = lib.types.str;
        default = "${homeDirectory}/.local/bin/pi-daemon";
        description = "Exact owner-controlled executable preferred by the stable service launcher when mutableRuntime is enabled. The Nix package remains the fallback.";
      };
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
            assertion =
              instance.dashboardAuth.identityProviderFile == null
              || instance.dashboardAuth.identities == [];
            message = "services.pi-daemon.instances.${name}: dashboardAuth.identityProviderFile and identities are mutually exclusive";
          })
          enabledInstances)
        ++ (lib.mapAttrsToList (name: instance: {
            assertion = unique (map (identity: identity.identityId) instance.dashboardAuth.identities);
            message = "services.pi-daemon.instances.${name}: dashboardAuth identity IDs must be unique";
          })
          enabledInstances)
        ++ (lib.mapAttrsToList (name: instance: {
            assertion = unique (map (identity: identity.credentialFile) instance.dashboardAuth.identities);
            message = "services.pi-daemon.instances.${name}: dashboardAuth credentialFile paths must be unique";
          })
          enabledInstances)
        ++ (lib.mapAttrsToList (name: instance: {
            assertion =
              instance.dashboardAuth.identities == []
              || lib.any (identity: identity.globalRole == "administrator") instance.dashboardAuth.identities;
            message = "services.pi-daemon.instances.${name}: dashboardAuth identities require at least one administrator";
          })
          enabledInstances)
        ++ (lib.mapAttrsToList (name: instance: {
            assertion = !instance.api.enable || instance.api.port != null;
            message = "services.pi-daemon.instances.${name}: api.port is required when api.enable is true";
          })
          enabledInstances)
        ++ (lib.mapAttrsToList (name: instance: {
            assertion = !instance.dedicatedWeb.enable || instance.api.enable;
            message = "services.pi-daemon.instances.${name}: api.enable is required for dedicatedWeb";
          })
          enabledInstances)
        ++ (lib.mapAttrsToList (name: instance: {
            assertion = !instance.dedicatedWeb.enable || instance.dedicatedWeb.port != null;
            message = "services.pi-daemon.instances.${name}: dedicatedWeb.port is required when dedicatedWeb.enable is true";
          })
          enabledInstances)
        ++ (lib.mapAttrsToList (name: instance: {
            assertion =
              (instance.dedicatedWeb.tls.certFile == null)
              == (instance.dedicatedWeb.tls.keyFile == null);
            message = "services.pi-daemon.instances.${name}: dedicatedWeb native TLS requires both tls.certFile and tls.keyFile";
          })
          enabledInstances)
        ++ (lib.mapAttrsToList (name: instance: {
            assertion =
              instance.dedicatedWeb.tls.certFile == null
              || (
                instance.dedicatedWeb.publicOrigin != null
                && lib.hasPrefix "https://" instance.dedicatedWeb.publicOrigin
              );
            message = "services.pi-daemon.instances.${name}: dedicatedWeb native TLS requires an HTTPS publicOrigin";
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
            assertion = unique (
              (map (instance: instance.stateDir) enabledList)
              ++ (map (instance: instance.dedicatedWeb.stateDir) enabledDedicatedWebList)
            );
            message = "enabled Pi Daemon and dedicated Dash services must use unique stateDir values";
          }
          {
            assertion = unique (map (instance: instance.socketPath) enabledList);
            message = "enabled Pi Daemon instances must use unique socketPath values";
          }
          {
            assertion = unique (
              (map (instance: instance.stdoutLog) enabledList)
              ++ (map (instance: instance.dedicatedWeb.stdoutLog) enabledDedicatedWebList)
            );
            message = "enabled Pi Daemon and dedicated Dash services must use unique stdoutLog values";
          }
          {
            assertion = unique (
              (map (instance: instance.stderrLog) enabledList)
              ++ (map (instance: instance.dedicatedWeb.stderrLog) enabledDedicatedWebList)
            );
            message = "enabled Pi Daemon and dedicated Dash services must use unique stderrLog values";
          }
          {
            assertion = unique (
              (map (instance: instance.api.port) enabledApiInstances)
              ++ (map (instance: instance.dedicatedWeb.port) enabledDedicatedWebList)
            );
            message = "enabled Pi Daemon API and dedicated Dash services must use unique ports";
          }
          {
            assertion = unique (map effectiveApiTokenFile enabledApiInstances);
            message = "enabled Pi Daemon APIs must use unique effective token files";
          }
          {
            assertion = unique (map (instance: instance.dedicatedWeb.stateDir) enabledDedicatedWebList);
            message = "enabled dedicated Dash services must use unique stateDir values";
          }
          {
            assertion = unique (map (instance: instance.dedicatedWeb.stdoutLog) enabledDedicatedWebList);
            message = "enabled dedicated Dash services must use unique stdoutLog values";
          }
          {
            assertion = unique (map (instance: instance.dedicatedWeb.stderrLog) enabledDedicatedWebList);
            message = "enabled dedicated Dash services must use unique stderrLog values";
          }
        ];

      home.packages = [cfg.package];
      home.activation =
        (lib.mapAttrs' (name: instance:
          lib.nameValuePair "piDaemon-${name}-directories" (
            lib.hm.dag.entryAfter ["writeBoundary"] ''
              run install -d -m 700 ${lib.escapeShellArg instance.stateDir}
              run install -d -m 700 ${lib.escapeShellArg instance.agentDir}
              run install -d -m 700 ${lib.escapeShellArg (builtins.dirOf instance.socketPath)}
              run install -d -m 700 ${lib.escapeShellArg (builtins.dirOf instance.stdoutLog)}
              run install -d -m 700 ${lib.escapeShellArg (builtins.dirOf instance.stderrLog)}
            ''
          ))
        enabledInstances)
        // (lib.mapAttrs' (name: instance:
          lib.nameValuePair "piDaemonWeb-${name}-directories" (
            lib.hm.dag.entryAfter ["writeBoundary"] ''
              run install -d -m 700 ${lib.escapeShellArg instance.dedicatedWeb.stateDir}
              run install -d -m 700 ${lib.escapeShellArg (builtins.dirOf instance.dedicatedWeb.stdoutLog)}
              run install -d -m 700 ${lib.escapeShellArg (builtins.dirOf instance.dedicatedWeb.stderrLog)}
            ''
          ))
        enabledDedicatedWebInstances);
    }

    (lib.mkIf (isLinux && !hasSupervisord) {
      systemd.user.services =
        (lib.mapAttrs' (name: instance:
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
        enabledInstances)
        // (lib.mapAttrs' (name: instance:
          lib.nameValuePair (webServiceName name) {
            Unit = {
              Description = "Pi Daemon dedicated Dash ${name}";
              Documentation = "https://github.com/harryaskham/pi-daemon";
              After = ["${serviceName name}.service"];
              Requires = ["${serviceName name}.service"];
            };
            Service = {
              Type = "simple";
              Environment = lib.mapAttrsToList (key: value: "${key}=${value}") (dedicatedWebEnv name instance);
              ExecStart = dedicatedWebCommand name instance;
              Restart = "always";
              RestartSec = instance.restartSec;
              UMask = "0077";
              StandardOutput = "journal";
              StandardError = "journal";
              SyslogIdentifier = webServiceName name;
            };
            Install.WantedBy = ["default.target"];
          })
        enabledDedicatedWebInstances);
    })

    (lib.mkIf isDarwin {
      launchd.agents =
        (lib.mapAttrs' (name: instance:
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
        enabledInstances)
        // (lib.mapAttrs' (name: instance:
          lib.nameValuePair (webServiceName name) {
            enable = true;
            config = {
              Label = "com.pi-daemon.web.${name}";
              ProgramArguments = dedicatedWebArgs name instance;
              EnvironmentVariables = dedicatedWebEnv name instance;
              RunAtLoad = true;
              KeepAlive = true;
              ThrottleInterval = instance.restartSec;
              ProcessType = "Background";
              StandardOutPath = instance.dedicatedWeb.stdoutLog;
              StandardErrorPath = instance.dedicatedWeb.stderrLog;
            };
          })
        enabledDedicatedWebInstances);
    })

    (lib.mkIf isLinux (lib.optionalAttrs hasSupervisord {
      supervisord.programs =
        (lib.mapAttrs' (name: instance:
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
        enabledInstances)
        // (lib.mapAttrs' (name: instance:
          lib.nameValuePair (webServiceName name) {
            command = dedicatedWebCommand name instance;
            environment = lib.concatStringsSep "," (
              lib.mapAttrsToList (key: value: "${key}=\"${value}\"") (dedicatedWebEnv name instance)
            );
            autorestart = "true";
            startsecs = 0;
            stdout_logfile = instance.dedicatedWeb.stdoutLog;
            stderr_logfile = instance.dedicatedWeb.stderrLog;
          })
        enabledDedicatedWebInstances);
    }))
  ]);
}
