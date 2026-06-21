package com.gte619n.anvil

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

object Notifications {
    const val CHANNEL = "anvil"

    fun ensureChannel(context: Context) {
        val mgr = context.getSystemService(NotificationManager::class.java)
        if (mgr.getNotificationChannel(CHANNEL) == null) {
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL, "Anvil", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Claude finished a turn or needs a decision"
                },
            )
        }
    }

    /**
     * Show a notification that deep-links to [sessionId] when tapped. When [kind] is "permission"
     * and a [requestId] is present, attach Allow / Deny action buttons that answer the parked
     * prompt directly from the shade (so it can't get lost behind an in-app dialog).
     */
    fun show(
        context: Context,
        title: String,
        body: String,
        sessionId: String?,
        kind: String? = null,
        requestId: String? = null,
        tool: String? = null,
    ) {
        ensureChannel(context)
        val notifId = sessionId?.hashCode() ?: 1
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            sessionId?.let { putExtra("sessionId", it) }
        }
        val pi = PendingIntent.getActivity(
            context,
            sessionId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_HIGH)

        if (kind == "permission" && requestId != null) {
            builder.addAction(0, "Allow", permissionAction(context, notifId, requestId, "allow"))
            builder.addAction(0, "Deny", permissionAction(context, notifId, requestId, "deny"))
            // Keep it up until answered — a self-dismissing prompt is easy to miss.
            builder.setAutoCancel(false)
            builder.setOngoing(true)
        }

        val nm = NotificationManagerCompat.from(context)
        if (nm.areNotificationsEnabled()) {
            try {
                nm.notify(notifId, builder.build())
            } catch (_: SecurityException) {
                /* permission revoked between the check and notify */
            }
        }
    }

    /** A PendingIntent that fires [PermissionActionReceiver] with the chosen [decision]. */
    private fun permissionAction(context: Context, notifId: Int, requestId: String, decision: String): PendingIntent {
        val intent = Intent(context, PermissionActionReceiver::class.java).apply {
            action = PermissionActionReceiver.ACTION
            putExtra(PermissionActionReceiver.EXTRA_REQUEST_ID, requestId)
            putExtra(PermissionActionReceiver.EXTRA_DECISION, decision)
            putExtra(PermissionActionReceiver.EXTRA_NOTIF_ID, notifId)
        }
        // Distinct request codes so Allow and Deny don't collapse into one PendingIntent.
        val requestCode = (requestId + decision).hashCode()
        return PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
