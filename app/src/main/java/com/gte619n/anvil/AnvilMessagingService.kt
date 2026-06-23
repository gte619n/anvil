package com.gte619n.anvil

import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/** Receives FCM pushes: registers the device token with the daemon and shows notifications. */
class AnvilMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Net.postJson(BuildConfig.ANVIL_BASE_URL, "/api/push/fcm/register", JSONObject().put("token", token))
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val n = message.notification
        val title = n?.title ?: message.data["title"] ?: "Anvil"
        val body = n?.body ?: message.data["body"] ?: ""
        // A "clear" push means the session was viewed/answered elsewhere — dismiss its reminder
        // here instead of showing one (the id is keyed off the session, matching Notifications.show).
        if (message.data["kind"] == "clear") {
            message.data["sessionId"]?.let { NotificationManagerCompat.from(this).cancel(it.hashCode()) }
            return
        }
        // All pushes are data-only (so this always fires, even backgrounded), routing every reminder
        // through the same session-keyed notification: it supersedes prior reminders for the session,
        // deep-links to it on tap, and clears when the app opens it. Permission pushes additionally
        // carry a requestId we answer with Allow/Deny action buttons right on the notification.
        Notifications.show(
            context = this,
            title = title,
            body = body,
            sessionId = message.data["sessionId"],
            kind = message.data["kind"],
            requestId = message.data["requestId"],
            tool = message.data["tool"],
            dir = message.data["dir"],
        )
    }
}
