package com.harryaskham.pidroid.sessionui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.SessionRole

private val StageCBackground = Color(0xff20242c)
private val StageCCard = Color(0xff2b303b)
private val StageCBorder = Color(0xff4c566a)
private val StageCText = Color(0xffeceff4)
private val StageCMuted = Color(0xffa7adba)
private val StageCAccent = Color(0xff88c0d0)
private val StageCWarning = Color(0xffebcb8b)

/** Bounded branch-tree renderer. It emits navigation intents only through the authority gate. */
@Composable
public fun SessionTreeSurface(
  snapshot: SessionTreeSnapshot,
  context: InteractionContext,
  modifier: Modifier = Modifier,
  onIntent: (TreeNavigationIntent) -> Unit = {},
) {
  val rows = SessionTreeProjection.rows(snapshot)
  Surface(
    modifier =
      modifier
        .fillMaxSize()
        .background(StageCBackground)
        .semantics { contentDescription = "Session branch tree, ${rows.size} entries" },
    color = StageCBackground,
  ) {
    Column(
      Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState()),
      verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Text("Branch tree", color = StageCText, fontSize = 24.sp, fontWeight = FontWeight.Bold)
      Text(
        interactionLabel(context),
        color = if (contextMayAct(context)) StageCAccent else StageCWarning,
        fontSize = 13.sp,
      )
      rows.forEach { row ->
        val intent =
          TreeNavigationIntent(
            identity = snapshot.identity,
            correlationId = "tree-ui-${row.entry.id.hashCode().toUInt().toString(16)}",
            entryId = row.entry.id,
            summarize = false,
            customInstructions = null,
            label = null,
          )
        val decision = SessionTreeAuthority.authorize(snapshot, intent, context)
        Row(
          Modifier
            .fillMaxWidth()
            .border(1.dp, if (row.entry.active) StageCAccent else StageCBorder, MaterialTheme.shapes.medium)
            .background(StageCCard, MaterialTheme.shapes.medium)
            .padding(12.dp)
            .semantics { contentDescription = row.accessibilityLabel },
        ) {
          Spacer(Modifier.width((row.depth * 18).dp))
          Column(Modifier.weight(1f)) {
            Text(row.entry.label, color = StageCText, fontWeight = if (row.entry.active) FontWeight.Bold else FontWeight.Normal)
            Text(
              row.entry.kind.name
                .lowercase(),
              color = StageCMuted,
              fontSize = 12.sp,
            )
          }
          Button(
            onClick = {
              if (decision is InteractionDecision.Ready) onIntent(decision.intent)
            },
            enabled = decision is InteractionDecision.Ready,
            colors =
              ButtonDefaults.buttonColors(
                containerColor = StageCAccent,
                contentColor = StageCBackground,
                disabledContainerColor = StageCBorder,
                disabledContentColor = StageCMuted,
              ),
            modifier = Modifier.semantics { contentDescription = "Navigate to ${row.entry.label}" },
          ) {
            Text(if (row.entry.active) "Active" else "Open")
          }
        }
      }
    }
  }
}

/** Server-validated declarative view renderer; unknown nodes degrade to the supplied fallback. */
@Composable
public fun DeclarativeExtensionSurface(
  view: ExtensionViewState,
  context: InteractionContext,
  modifier: Modifier = Modifier,
  formValues: Map<String, ExtensionFormValue> = emptyMap(),
  onIntent: (ExtensionActionIntent) -> Unit = {},
) {
  Surface(
    modifier =
      modifier
        .fillMaxSize()
        .background(StageCBackground)
        .semantics { contentDescription = "Declarative extension ${view.title}, revision ${view.revision}" },
    color = StageCBackground,
  ) {
    Column(
      Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState()),
      verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Text(view.title, color = StageCText, fontSize = 24.sp, fontWeight = FontWeight.Bold)
      Text(
        "${interactionLabel(context)} · ${view.nodes.size} bounded nodes",
        color = if (contextMayAct(context) && view.freshness == CacheFreshness.FRESH) StageCAccent else StageCWarning,
        fontSize = 13.sp,
      )
      RenderExtensionNode(view.root, view, context, formValues, onIntent)
    }
  }
}

@Composable
private fun RenderExtensionNode(
  node: ExtensionNode,
  view: ExtensionViewState,
  context: InteractionContext,
  formValues: Map<String, ExtensionFormValue>,
  onIntent: (ExtensionActionIntent) -> Unit,
) {
  when (node) {
    is ExtensionNode.Container -> {
      Column(
        Modifier
          .fillMaxWidth()
          .border(1.dp, StageCBorder, MaterialTheme.shapes.medium)
          .background(StageCCard, MaterialTheme.shapes.medium)
          .padding(12.dp)
          .semantics { contentDescription = node.accessibilityLabel },
        verticalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        node.children.forEach { RenderExtensionNode(it, view, context, formValues, onIntent) }
      }
    }

    is ExtensionNode.Content -> {
      Column(Modifier.fillMaxWidth().semantics { contentDescription = node.accessibilityLabel }) {
        Text(node.label, color = StageCText, fontWeight = FontWeight.SemiBold)
        node.detail?.let { Text(it, color = StageCMuted, fontSize = 12.sp) }
      }
    }

    is ExtensionNode.Action -> {
      ExtensionActionButton(node.actionId, node.label, emptyMap(), view, context, onIntent)
    }

    is ExtensionNode.Form -> {
      Column(
        Modifier
          .fillMaxWidth()
          .border(1.dp, StageCBorder, MaterialTheme.shapes.medium)
          .padding(12.dp)
          .semantics { contentDescription = node.accessibilityLabel },
        verticalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        node.fields.forEach { field ->
          Text(
            "${field.label}${if (field.required) " · required" else ""}",
            color = StageCText,
            fontSize = 13.sp,
            modifier = Modifier.semantics { contentDescription = "Extension form field ${field.label}" },
          )
        }
        ExtensionActionButton(node.submitActionId, node.submitLabel, formValues, view, context, onIntent)
      }
    }

    is ExtensionNode.Unsupported -> {
      Column(
        Modifier
          .fillMaxWidth()
          .border(1.dp, StageCWarning, MaterialTheme.shapes.medium)
          .padding(12.dp)
          .semantics { contentDescription = node.accessibilityLabel },
      ) {
        Text("Unsupported: ${node.wireType}", color = StageCWarning, fontWeight = FontWeight.Bold)
        Text(node.fallbackText, color = StageCText)
      }
    }
  }
}

@Composable
private fun ExtensionActionButton(
  actionId: String,
  label: String,
  values: Map<String, ExtensionFormValue>,
  view: ExtensionViewState,
  context: InteractionContext,
  onIntent: (ExtensionActionIntent) -> Unit,
) {
  val decision = ExtensionInteractionAuthority.authorizeAction(view, actionId, values, context)
  Button(
    onClick = {
      if (decision is InteractionDecision.Ready) onIntent(decision.intent)
    },
    enabled = decision is InteractionDecision.Ready,
    modifier = Modifier.semantics { contentDescription = "Extension action $label" },
  ) {
    Text(label)
  }
}

private fun contextMayAct(context: InteractionContext): Boolean =
  context.role == SessionRole.CONTROLLER && context.freshness == CacheFreshness.FRESH

private fun interactionLabel(context: InteractionContext): String =
  if (contextMayAct(
      context,
    )
  ) {
    "Controller · fresh"
  } else {
    "${context.role.name.lowercase().replaceFirstChar(Char::uppercase)} · actions unavailable"
  }
