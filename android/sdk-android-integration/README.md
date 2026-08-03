# Pi Droid Android integration foundation

This fast-lane JVM module defines the pure policy and reducer contracts that a
later Android adapter uses for notifications and user-started background
monitoring. It contains no Android plugin, socket, session command, FCM, app
shell, widget, floating overlay, credential, key, Play, or real network
implementation.

## Contracts

- content-safe `activity`, `terminal`, `input-required`, and `host-state` notification channels;
- exact host/session mute plus wraparound quiet-hours suppression;
- bounded notification dedupe keyed by local host, bearer generation, host
  incarnation, session, generation, and event ID;
- user-started `dataSync` foreground-monitor reference state, maximum eight
  sessions and six hours;
- explicit permission denial/revocation, Doze, network reconnect, timeout, and
  user Stop transitions;
- WorkManager-compatible catch-up with a 15-minute floor, network/battery
  constraints, injected transport, policy/dedupe, and stale/offline suppression.

The models carry identity and safe state only. They never carry prompt/model/tool
content, bearers, credentials, or commands. Android lifecycle/service/notification
adapters belong to the integrating follow-up after interactive Stage C.

Focused validation:

```console
nix develop .#android --command ./android/gradlew -p android --no-daemon \
  :sdk-android-integration:test \
  --tests com.harryaskham.pidroid.integration.NotificationAndBackgroundContractTest
```
