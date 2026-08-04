package com.harryaskham.pidroid.sessionui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val InteractivePanel = Color(0xFF101A28)
private val InteractiveElevated = Color(0xFF1A283A)
private val InteractiveBorder = Color(0xFF31445E)
private val InteractivePrimary = Color(0xFFEAF1F8)
private val InteractiveMuted = Color(0xFF95A7BE)
private val InteractiveAccent = Color(0xFF88D5E7)
private val InteractiveGreen = Color(0xFFA8DDA3)
private val InteractiveWarning = Color(0xFFE9CB88)
private val InteractiveError = Color(0xFFE58D96)

/**
 * Stage C rich interaction chrome over the existing readonly [SessionSurface]. It emits inert typed
 * intents only; sdk-core owns controller/correlation admission and the embedding transport owns I/O.
 */
@Composable
public fun RichInteractiveSessionSurface(
  session: SessionSurfaceState,
  interactive: RichInteractiveState,
  layout: SessionSurfaceLayout,
  modifier: Modifier = Modifier,
  onAction: (RichInteractionAction) -> Unit = {},
) {
  val panelHeight = if (interactive.canMutate) 154.dp else 92.dp
  Box(modifier.fillMaxSize()) {
    SessionSurface(
      state = session,
      layout = layout,
      modifier = Modifier.fillMaxSize().padding(bottom = panelHeight + 8.dp),
      chrome = SessionSurfaceChrome.INTERACTIVE,
    )
    Surface(
      modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(10.dp),
      color = InteractivePanel,
      shape = RoundedCornerShape(20.dp),
      border = BorderStroke(1.dp, InteractiveBorder),
      shadowElevation = 10.dp,
    ) {
      if (interactive.canMutate) {
        ControllerComposer(interactive, layout, onAction)
      } else {
        ObserverPanel(interactive, onAction)
      }
    }
  }
}

@Composable
private fun ControllerComposer(
  state: RichInteractiveState,
  layout: SessionSurfaceLayout,
  onAction: (RichInteractionAction) -> Unit,
) {
  Column(
    modifier = Modifier.padding(horizontal = 14.dp, vertical = 11.dp),
    verticalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Surface(
        modifier = Modifier.semantics { contentDescription = "Controller authority active" },
        color = InteractiveGreen.copy(alpha = 0.14f),
        shape = RoundedCornerShape(999.dp),
      ) {
        Text(
          "CONTROLLER",
          modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
          color = InteractiveGreen,
          fontSize = 10.sp,
          fontWeight = FontWeight.Bold,
          letterSpacing = 1.sp,
        )
      }
      Text(
        "${state.modelLabel} · ${state.thinkingLevel}",
        modifier = Modifier.weight(1f),
        color = InteractiveMuted,
        fontSize = 11.sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      Button(
        onClick = { onAction(RichInteractionAction.ReleaseControl) },
        colors = ButtonDefaults.buttonColors(containerColor = InteractiveElevated, contentColor = InteractiveMuted),
      ) {
        Text("Release", fontSize = 11.sp)
      }
    }
    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      OutlinedTextField(
        value = state.draftText,
        onValueChange = { onAction(RichInteractionAction.DraftChanged(it)) },
        modifier =
          Modifier
            .weight(1f)
            .semantics { contentDescription = "Session prompt composer" },
        singleLine = layout.formFactor == SessionSurfaceFormFactor.PHONE,
        maxLines = if (layout.formFactor == SessionSurfaceFormFactor.PHONE) 1 else 3,
        placeholder = { Text("Message this session", color = InteractiveMuted) },
        colors =
          OutlinedTextFieldDefaults.colors(
            focusedTextColor = InteractivePrimary,
            unfocusedTextColor = InteractivePrimary,
            focusedBorderColor = InteractiveAccent,
            unfocusedBorderColor = InteractiveBorder,
            cursorColor = InteractiveAccent,
          ),
        shape = RoundedCornerShape(14.dp),
      )
      val submitDescription = if (state.streaming) "Send follow-up" else "Send prompt"
      Button(
        onClick = {
          val action =
            if (state.streaming) {
              RichInteractionAction.SubmitFollowUp(state.draftText)
            } else {
              RichInteractionAction.SubmitPrompt(state.draftText)
            }
          onAction(action)
        },
        modifier = Modifier.semantics { contentDescription = submitDescription },
        enabled = state.draftText.isNotBlank(),
        colors = ButtonDefaults.buttonColors(containerColor = InteractiveAccent, contentColor = InteractivePanel),
      ) {
        Text(if (state.streaming) "Follow up" else "Send", fontWeight = FontWeight.Bold)
      }
      if (state.streaming) {
        Button(
          onClick = { onAction(RichInteractionAction.Abort) },
          modifier = Modifier.semantics { contentDescription = "Abort active request" },
          colors = ButtonDefaults.buttonColors(containerColor = InteractiveError.copy(alpha = 0.18f), contentColor = InteractiveError),
        ) {
          Text("Abort", fontWeight = FontWeight.Bold)
        }
      }
    }
  }
}

@Composable
private fun ObserverPanel(
  state: RichInteractiveState,
  onAction: (RichInteractionAction) -> Unit,
) {
  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 16.dp, vertical = 13.dp)
        .semantics {
          contentDescription = "Observer authority; request control to interact"
        },
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Surface(color = InteractiveWarning.copy(alpha = 0.14f), shape = RoundedCornerShape(999.dp)) {
      Text(
        when (state.authority) {
          RichAuthorityRole.REQUESTING -> "REQUESTING"
          RichAuthorityRole.LOST -> "CONNECTION LOST"
          else -> "OBSERVER"
        },
        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        color = InteractiveWarning,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.sp,
      )
    }
    Column(Modifier.weight(1f)) {
      Text(
        if (state.authority == RichAuthorityRole.LOST) "Reconnect before sending another command" else "Readonly until control is granted",
        color = InteractivePrimary,
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
      )
      Text("${state.modelLabel} · ${state.thinkingLevel}", color = InteractiveMuted, fontSize = 11.sp)
    }
    Button(
      onClick = { onAction(RichInteractionAction.RequestControl) },
      modifier = Modifier.widthIn(min = 132.dp).semantics { contentDescription = "Request session control" },
      enabled = state.authority == RichAuthorityRole.OBSERVER,
      colors = ButtonDefaults.buttonColors(containerColor = InteractiveAccent, contentColor = InteractivePanel),
    ) {
      Text("Request control", fontWeight = FontWeight.Bold)
    }
  }
}
