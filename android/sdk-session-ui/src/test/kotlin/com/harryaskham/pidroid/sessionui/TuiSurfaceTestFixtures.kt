package com.harryaskham.pidroid.sessionui

internal object TuiSurfaceTestFixtures {
  fun snapshotJson(
    hostInstanceId: String = "host-fixture-01",
    sessionId: String = "session-fixture-01",
    generation: Int = 3,
    rows: Int = 24,
    columns: Int = 80,
    cursorRow: Int = 1,
    title: String = "Pi fixture",
  ): String =
    """
    {
      "identity": {
        "hostInstanceId": "$hostInstanceId",
        "sessionId": "$sessionId",
        "generation": $generation
      },
      "dimensions": { "rows": $rows, "columns": $columns },
      "rows": [
        {
          "row": 0,
          "runs": [
            { "text": "Pi Droid terminal", "style": { "bold": true, "foreground": "#88d5e7" } }
          ]
        },
        {
          "row": 1,
          "runs": [
            { "text": "Waiting for input", "style": { "dim": true } }
          ]
        },
        {
          "row": 2,
          "runs": [
            { "text": "Host workstation · generation 3", "style": { "foreground": "#a7d8a2" } }
          ]
        },
        {
          "row": 3,
          "runs": [
            { "text": "Ready for terminal input", "style": {} }
          ]
        }
      ],
      "cursor": { "row": $cursorRow, "column": 0, "visible": true, "shape": "block" },
      "title": ${jsonString(title)},
      "highWaterCursor": "dash:fixture:host-fixture-01:session-fixture-01:3:40"
    }
    """.trimIndent()

  fun deltaJson(
    hostInstanceId: String = "host-fixture-01",
    sequence: Long = 41,
    changedRow: Int = 0,
  ): String =
    """
    {
      "dashVersion": "1.0",
      "requestId": "req-stream-01",
      "serverInstanceId": "dash-fixture-01",
      "clientId": "client-fixture-01",
      "workspaceId": "workspace-fixture-01",
      "kind": "tui_delta",
      "correlationId": "correlation-tui-01",
      "subscriptionId": "subscription-tui-fixture-01",
      "delta": {
        "kind": "tui_delta",
        "identity": {
          "hostInstanceId": "$hostInstanceId",
          "sessionId": "session-fixture-01",
          "generation": 3
        },
        "cursor": "dash:fixture:host-fixture-01:session-fixture-01:3:$sequence",
        "sequence": $sequence,
        "dimensions": { "rows": 24, "columns": 80 },
        "changedRows": [
          {
            "row": $changedRow,
            "runs": [ { "text": "Pi fixture", "style": { "bold": true } } ]
          }
        ],
        "cursorState": { "row": 1, "column": 0, "visible": true, "shape": "block" },
        "title": "Pi fixture"
      }
    }
    """.trimIndent()

  fun replayGapJson(): String =
    """
    {
      "dashVersion": "1.0",
      "requestId": "req-stream-01",
      "serverInstanceId": "dash-fixture-01",
      "clientId": "client-fixture-01",
      "workspaceId": "workspace-fixture-01",
      "kind": "replay_gap",
      "correlationId": "correlation-gap-01",
      "subscriptionId": "subscription-fixture-01",
      "gap": {
        "kind": "replay_gap",
        "identity": {
          "hostInstanceId": "host-fixture-01",
          "sessionId": "session-fixture-01",
          "generation": 3
        },
        "reason": "cursor-expired",
        "requestedCursor": "dash:fixture:expired",
        "highWaterCursor": "dash:fixture:host-fixture-01:session-fixture-01:3:41",
        "oldestAvailableCursor": "dash:fixture:host-fixture-01:session-fixture-01:3:40",
        "snapshotFollows": true
      }
    }
    """.trimIndent()

  fun observerState(): TuiFrameState = TuiFrameDecoder.decodeSnapshot(snapshotJson(), TuiControlRole.OBSERVER)

  fun controllerState(): TuiFrameState = TuiFrameDecoder.decodeSnapshot(snapshotJson(), TuiControlRole.CONTROLLER)

  private fun jsonString(value: String): String =
    buildString {
      append('"')
      value.forEach { character ->
        when (character) {
          '"' -> append("\\\"")
          '\\' -> append("\\\\")
          '\n' -> append("\\n")
          '\r' -> append("\\r")
          '\t' -> append("\\t")
          else -> append(character)
        }
      }
      append('"')
    }
}
