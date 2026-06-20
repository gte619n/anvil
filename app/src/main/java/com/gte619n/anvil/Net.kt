package com.gte619n.anvil

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Tiny fire-and-forget JSON POST helper (token registration, etc.). */
object Net {
    fun postJson(base: String, path: String, body: JSONObject) {
        Thread {
            try {
                val conn = (URL(base.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    doOutput = true
                    connectTimeout = 8_000
                    readTimeout = 10_000
                    setRequestProperty("Content-Type", "application/json")
                }
                conn.outputStream.use { it.write(body.toString().toByteArray()) }
                conn.responseCode // force the request
                conn.disconnect()
            } catch (_: Exception) {
                /* best-effort */
            }
        }.start()
    }
}
