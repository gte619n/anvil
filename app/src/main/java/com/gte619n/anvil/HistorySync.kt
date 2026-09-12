package com.gte619n.anvil

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Closed-app background sync (comprehensive-offline spec §4.4a). On an FCM activity push we pull the
 * session's history over the daemon's REST endpoint while the app is backgrounded and STAGE the response
 * in SharedPreferences; MainActivity hands the staged batch to the web layer on next load, which applies
 * it to the offline event mirror (window.__anvilApplyStagedHistory).
 *
 * Best-effort by design — FCM delivery and Doze make this a narrowing of the cold-open gap, NOT a
 * guarantee; the connect-time prefetch remains authoritative. Deliberately uses a plain Thread +
 * SharedPreferences (no WorkManager dependency) so it adds no new Gradle deps.
 */
object HistorySync {
    private const val PREFS = "anvil.sync"
    private const val KEY = "staged"
    private const val MAX_STAGED = 20

    /** Fetch `sessionId`'s history (full snapshot — the background job doesn't track the mirror's seq)
     *  and stage it, replacing any prior staged entry for the same session. Fire-and-forget. */
    fun stage(context: Context, base: String, sessionId: String) {
        val appContext = context.applicationContext
        Thread {
            val body = Net.getString(base, "/api/sessions/$sessionId/history") ?: return@Thread
            val response = runCatching { JSONObject(body) }.getOrNull() ?: return@Thread
            synchronized(HistorySync) {
                val prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val current = runCatching { JSONArray(prefs.getString(KEY, "[]")) }.getOrDefault(JSONArray())
                val next = JSONArray()
                for (i in 0 until current.length()) {
                    val e = current.optJSONObject(i) ?: continue
                    if (e.optString("sessionId") != sessionId) next.put(e) // drop the stale entry for this session
                }
                next.put(JSONObject().put("sessionId", sessionId).put("response", response))
                // Keep only the most recent MAX_STAGED so a burst can't grow the blob unbounded.
                val capped = JSONArray()
                for (i in maxOf(0, next.length() - MAX_STAGED) until next.length()) capped.put(next.get(i))
                prefs.edit().putString(KEY, capped.toString()).apply()
            }
        }.start()
    }

    /** Return the staged batch as a JSON array string (for window.__anvilApplyStagedHistory) and clear
     *  it. Null when nothing is staged. */
    fun drain(context: Context): String? {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val staged = prefs.getString(KEY, null) ?: return null
        prefs.edit().remove(KEY).apply()
        return if (staged.isBlank() || staged == "[]") null else staged
    }
}
