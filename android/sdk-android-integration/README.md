# Pi Droid Android notification integration

This fast-lane JVM module defines notification policy, bounded background-monitor
reducers, and thin ports for a future Android host. It contains no Android
plugin, socket, session command executor, FCM, app shell, widget, floating
overlay, credential, key, Play, or real network implementation.

## Contracts

- content-safe `activity`, `terminal`, `input-required`, and `host-state`
  notification channels with fixed generic copy;
- validated SDK `attach_ready`, replay-gap, `agent_start`, and `agent_settled`
  mapping plus explicit wake, disconnect, input-required, and failed-terminal
  lifecycle facts;
- exact host/session mute plus wraparound quiet-hours suppression;
- bounded notification dedupe keyed by local host, bearer generation, host
  incarnation, session, generation, and event ID;
- notification action plans that expose Abort or Follow Up only for the exact
  session under fresh controller authority; callers must revalidate before
  execution;
- user-started `dataSync` foreground-monitor reference state, maximum eight
  sessions and six hours, projected through an injected service driver;
- explicit permission denial/revocation, Doze, network reconnect, timeout, and
  user Stop transitions;
- WorkManager-compatible catch-up with a 15-minute floor, network/battery
  constraints, injected transport and notification sink, policy/dedupe, and
  stale/offline suppression.

The models carry identity and safe state only. They never retain prompt, model,
tool or extension content, bearers, credentials, or commands. The embedding app
owns Android `Service`, `WorkManager`, notification APIs, transport, and fresh
authority revalidation.

Focused validation:

```console
nix develop .#android --command ./android/gradlew -p android --no-daemon \
  :sdk-android-integration:test
```

A gated evidence test renders a 430x932 generic notification-state PNG without
adding it to product history:

```console
PI_DROID_NOTIFICATION_SCREENSHOT_DIR="$PWD/artifacts/pi-droid-notifications" \
  nix develop .#android --command ./android/gradlew -p android --no-daemon \
  :sdk-android-integration:test \
  --tests com.harryaskham.pidroid.integration.NotificationStateScreenshotArtifactTest \
  --rerun-tasks
```
