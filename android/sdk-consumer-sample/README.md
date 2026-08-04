# Pi Droid SDK consumer fixture

This standalone Android library proves downstream consumption from the extracted,
checksum-pinned local Maven repository. It does not use project dependencies or
`mavenLocal()`.

```console
../gradlew -p sdk-consumer-sample --no-daemon \
  -PpiDroidSdkRepositoryDir=/absolute/path/to/extracted/repository \
  :consumer:assembleDebug :consumer:lintDebug
```

The embedding application implements `PiDaemonTransport` and owns authentication,
TLS, connection pooling, cancellation, credential lifetime, and request factories.
The SDK receives neutral requests/responses/events only. A private bridge, if used,
must be non-exported and caller-UID checked or app-private Unix-domain transport;
loopback alone is not a security boundary.

The sample contains no app activity, service, receiver, provider, shared UID,
credential getter, endpoint, or product navigation. It compiles the canonical
session and workspace composables from exact Maven coordinates. Cacophony’s actual
Android integration and cross-app screenshots are separately owned and stay gated
until this fixture and the immutable bundle pass.
