package com.gte619n.anvil

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/**
 * Handles the Allow/Deny action buttons on a permission notification: POSTs the decision to the
 * daemon's REST endpoint (no open WebSocket required) and dismisses the notification. This lets the
 * user answer a parked permission prompt straight from the notification shade, so the request never
 * gets stranded behind a lost in-app dialog.
 */
class PermissionActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val requestId = intent.getStringExtra(EXTRA_REQUEST_ID) ?: return
        val decision = intent.getStringExtra(EXTRA_DECISION) ?: return
        val notifId = intent.getIntExtra(EXTRA_NOTIF_ID, 0)
        Net.postJson(
            BuildConfig.ANVIL_BASE_URL,
            "/api/permission/respond",
            JSONObject().put("requestId", requestId).put("decision", decision),
        )
        // Dismiss immediately; the daemon broadcasts the resulting status to any open clients.
        if (notifId != 0) NotificationManagerCompat.from(context).cancel(notifId)
    }

    companion object {
        const val ACTION = "com.gte619n.anvil.PERMISSION_ACTION"
        const val EXTRA_REQUEST_ID = "requestId"
        const val EXTRA_DECISION = "decision"
        const val EXTRA_NOTIF_ID = "notifId"
    }
}
