---
layout: default
title: Dashboard transport security
---

# Dashboard transport security

Pi Daemon Dash supports two production deployment shapes:

1. **Loopback HTTP behind an operator-owned HTTPS reverse proxy** (recommended
   when a proxy already owns certificates and policy).
2. **Native HTTPS/WSS** in the embedded `serve` process or dedicated
   `pi-daemon web` process.

A plaintext listener is always loopback-only. Native TLS is required before
`web.bind` may name a non-loopback address. A browser-visible non-loopback HTTP
origin is rejected unless the explicit development-only
`web.allowInsecureHttp`/`--web-allow-insecure-http true` escape hatch is set.
That escape hatch does not permit a non-loopback plaintext listener.

## Exact public authority

`web.publicOrigin` (or `--public-origin`) is the single browser authority. It is
an origin only: scheme, host and optional port, with no credentials, path,
query, or fragment.

- Native TLS requires an `https://` public origin.
- TLS SNI must match the public-origin hostname.
- Every HTTP request and WebSocket upgrade must carry the exact public-origin
  `Host`.
- Mutations and WebSocket upgrades must carry the exact public-origin `Origin`.
- Browser code uses same-origin URLs, so an HTTPS page upgrades only to WSS and
  cannot silently downgrade to a mixed-content HTTP/WS endpoint.

The server never derives authority from `Forwarded` or `X-Forwarded-*` headers.
RFC `Forwarded` is rejected. `X-Forwarded-Host`, `X-Forwarded-Proto`, and
`X-Forwarded-Port` are rejected by default; with
`web.proxy.trustForwardedHeaders: true` they are accepted only from a loopback
peer and only when each supplied value exactly matches `publicOrigin`. They are
verification evidence, not routing input.

## Native TLS sources and rotation

Configure exactly one certificate source and one private-key source. File paths
are resolved relative to the selected instance YAML. CLI descriptors must be
inherited descriptors numbered 3 or higher.

```yaml
web:
  enabled: true
  mode: dedicated
  bind: 0.0.0.0
  port: 7465
  publicOrigin: https://dash.example.test
  tls:
    certFile: /run/secrets/pi-daemon-dash-cert
    keyFile: /run/secrets/pi-daemon-dash-key
    reloadIntervalMs: 30000
```

Equivalent CLI sources are:

```console
pi-daemon web --config ~/.config/pi/daemon/work/config.yaml --instance work \
  --web-bind 0.0.0.0 --web-port 7465 \
  --public-origin https://dash.example.test \
  --tls-cert-file /run/secrets/pi-daemon-dash-cert \
  --tls-key-file /run/secrets/pi-daemon-dash-key \
  --tls-reload-ms 30000

# One-shot descriptor material (not reloadable):
pi-daemon web ... --tls-cert-fd 3 --tls-key-fd 4
```

Material is bounded to 1 MiB per source. A certificate file must be a regular,
owner/root-controlled resolved target that is not group/world writable. A
private-key file must additionally be owner-only. Paths may resolve through a
secret-manager symlink, but the opened final target is protected against a
second symlink traversal and is revalidated on every reload.

File-backed pairs are polled at the configured interval (minimum one second).
The new pair is parsed and installed as one secure context; invalid, mismatched,
partially rotated, unreadable, or over-limit material leaves the prior context
active and increments only a content-free failure metric. Existing connections
continue, and new handshakes receive the new certificate after a successful
swap. Descriptor sources are consumed once and cannot be configured for reload.
TLS 1.2 is the minimum protocol version.

Certificate and key bytes never enter YAML, argv, Nix store derivations, status,
health, metrics, or logs. Only file paths or inherited descriptor numbers are
configuration values.

## Reverse-proxy mode

Keep `web.bind` on literal loopback, configure the exact HTTPS public origin,
and let the proxy preserve that Host:

```yaml
web:
  enabled: true
  mode: dedicated
  bind: 127.0.0.1
  port: 7465
  publicOrigin: https://dash.example.test
  proxy:
    trustForwardedHeaders: true
```

The proxy should terminate TLS, forward to `http://127.0.0.1:7465`, preserve
`Host: dash.example.test`, and either omit forwarded authority headers or send
only the exact public host, `https` protocol, and public port. The server does
not need `X-Forwarded-For` for authentication or logging.

An HTTPS public origin enables the `Secure` `__Host-pi-daemon-dash` HttpOnly,
SameSite=Strict cookie and `Strict-Transport-Security: max-age=31536000` in both
native and reverse-proxy deployments. HTTP loopback development keeps the
non-`__Host-` cookie and emits no HSTS.

## Home Manager

`services.pi-daemon.instances.<name>.dedicatedWeb` exposes:

- `publicOrigin`
- `allowInsecurePublicOrigin`
- `trustProxyHeaders`
- `tls.certFile`
- `tls.keyFile`
- `tls.reloadIntervalMs`

Use runtime secret paths such as `config.sops.secrets.<name>.path`. The module
passes paths, never PEM values, to the supervised process and asserts that
certificate/key configuration is paired and has an HTTPS public origin. The
same options are available in instance YAML for embedded mode.

## Health and failure behavior

`GET` or `HEAD /dash/healthz` is a content-free, no-store transport health probe.
It still requires exact Host and proxy-header validation, but no browser login,
and returns `204` only after the listener is ready. It reveals no session,
inventory, credential, path, certificate, or backend data.

Transport failure is fail-closed:

- plaintext sent to a native TLS port never reaches HTTP routing;
- wrong SNI fails the TLS handshake;
- wrong Host, Origin, or trusted-proxy evidence is rejected;
- an invalid rotated pair leaves the last valid pair active;
- shutdown clears rotation timers, revokes browser sessions, closes WebSockets,
  and drains the listener under the existing whole-service deadline.
