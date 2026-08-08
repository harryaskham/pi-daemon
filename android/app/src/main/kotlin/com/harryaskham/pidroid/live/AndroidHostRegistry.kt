package com.harryaskham.pidroid.live

import android.content.Context
import com.harryaskham.pidroid.sdk.core.CredentialHandle
import com.harryaskham.pidroid.sdk.core.HostCredentialVault
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.HostIdGenerator
import com.harryaskham.pidroid.sdk.core.HostRegistry
import com.harryaskham.pidroid.sdk.core.HostRegistryStore
import com.harryaskham.pidroid.sdk.core.PairingPayload
import com.harryaskham.pidroid.sdk.core.PairingPayloadCodec
import com.harryaskham.pidroid.sdk.core.RegisteredHost
import com.harryaskham.pidroid.sdk.core.TransportSecurity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import java.net.URI
import java.util.UUID

public class PreferencesHostRegistryStore(
  context: Context,
) : HostRegistryStore {
  private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
  private val json = Json

  override suspend fun list(): List<RegisteredHost> {
    val encoded = preferences.getString(HOSTS_KEY, null) ?: return emptyList()
    val array = runCatching { json.parseToJsonElement(encoded) as? JsonArray }.getOrNull() ?: return emptyList()
    return array.mapNotNull(::decodeHost).take(MAX_HOSTS)
  }

  override suspend fun upsert(host: RegisteredHost) {
    val hosts = list().filterNot { it.id == host.id }.plus(host).sortedBy { it.id.value }
    require(hosts.size <= MAX_HOSTS) { "host registry is full" }
    write(hosts)
  }

  override suspend fun remove(hostId: HostId) {
    write(list().filterNot { it.id == hostId })
  }

  private fun write(hosts: List<RegisteredHost>) {
    val encoded = JsonArray(hosts.map(::encodeHost)).toString()
    check(encoded.length <= MAX_ENCODED_CHARS) { "host registry encoding is too large" }
    check(preferences.edit().putString(HOSTS_KEY, encoded).commit()) { "host registry persistence failed" }
  }

  private fun encodeHost(host: RegisteredHost): JsonObject =
    JsonObject(
      linkedMapOf(
        "id" to JsonPrimitive(host.id.value),
        "displayName" to JsonPrimitive(host.displayName),
        "baseUri" to JsonPrimitive(host.baseUri.toASCIIString()),
        "tlsFingerprint" to (host.tlsFingerprint?.let(::JsonPrimitive) ?: JsonNull),
        "transportSecurity" to JsonPrimitive(host.transportSecurity.name),
        "bearerGeneration" to JsonPrimitive(host.bearerGeneration),
      ),
    )

  private fun decodeHost(element: kotlinx.serialization.json.JsonElement): RegisteredHost? =
    runCatching {
      val host = element as JsonObject
      val id = HostId((host["id"] as JsonPrimitive).content)
      val generation = (host["bearerGeneration"] as JsonPrimitive).intOrNull ?: error("invalid generation")
      RegisteredHost(
        id = id,
        displayName = (host["displayName"] as JsonPrimitive).content,
        baseUri = URI((host["baseUri"] as JsonPrimitive).content),
        tlsFingerprint = (host["tlsFingerprint"] as? JsonPrimitive)?.content,
        transportSecurity = TransportSecurity.valueOf((host["transportSecurity"] as JsonPrimitive).content),
        bearerGeneration = generation,
        credential = CredentialHandle(id, generation),
      )
    }.getOrNull()

  private companion object {
    const val PREFERENCES: String = "pi-droid-host-registry"
    const val HOSTS_KEY: String = "hosts-v1"
    const val MAX_HOSTS: Int = 32
    const val MAX_ENCODED_CHARS: Int = 128 * 1_024
  }
}

public class PreferencesDefaultHostStore(
  context: Context,
) : DefaultHostStore {
  private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  override suspend fun read(): HostId? =
    preferences.getString(DEFAULT_HOST_KEY, null)?.let { value -> runCatching { HostId(value) }.getOrNull() }

  override suspend fun write(hostId: HostId?) {
    val editor = preferences.edit()
    if (hostId == null) editor.remove(DEFAULT_HOST_KEY) else editor.putString(DEFAULT_HOST_KEY, hostId.value)
    check(editor.commit()) { "default host persistence failed" }
  }

  private companion object {
    const val PREFERENCES: String = "pi-droid-host-registry"
    const val DEFAULT_HOST_KEY: String = "default-host-v1"
  }
}

public class AndroidHostRegistry(
  context: Context,
) {
  public val credentialVault: HostCredentialVault =
    HostCredentialVault(AndroidKeystoreCredentialProtector(), FileNoBackupCredentialStore(context))
  private val store = PreferencesHostRegistryStore(context)
  public val defaultHostStore: DefaultHostStore = PreferencesDefaultHostStore(context)
  public val registry: HostRegistry =
    HostRegistry(
      store = store,
      credentials = credentialVault,
      ids = HostIdGenerator { HostId("host-${UUID.randomUUID()}") },
    )

  public suspend fun registerEnvelope(
    envelope: String,
    confirmInsecureHttp: Boolean,
  ): RegisteredHost = registry.register(PairingPayloadCodec.decode(envelope), confirmInsecureHttp)

  public suspend fun registerManual(
    apiUri: URI,
    displayName: String,
    bearer: CharArray,
    tlsFingerprint: String?,
    confirmInsecureHttp: Boolean,
  ): RegisteredHost {
    val payload = PairingPayload.create(apiUri, displayName, bearer, tlsFingerprint)
    return registry.register(payload, confirmInsecureHttp)
  }
}
