package com.gte619n.anvil

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
        Notifications.show(this, title, body, message.data["sessionId"])
    }
}
