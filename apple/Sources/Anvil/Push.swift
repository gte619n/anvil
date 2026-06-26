#if os(iOS)
import UIKit
import UserNotifications

/// iOS/iPadOS app delegate: owns APNs registration and notification handling — the analog of the
/// Android FCM service (AnvilMessagingService + Notifications + PermissionActionReceiver). The
/// daemon sends visible alert pushes (see anvild/src/push/apns.ts); we attach Allow/Deny action
/// buttons for the "permission" category and deep-link to the session on tap.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(PushManager.categories())
        center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { application.registerForRemoteNotifications() }
        }
        return true
    }

    // APNs handed us a device token — hex-encode and register it with the daemon.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        PushManager.register(token: hex)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("Anvil: APNs registration failed: \(error.localizedDescription)")
    }

    // Foreground delivery — still show the banner so in-session prompts aren't silently swallowed.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    // A tap or an Allow/Deny action button.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        PushManager.handle(response: response)
        completionHandler()
    }
}

/// APNs registration + notification-action plumbing. Talks to the same daemon endpoints the Android
/// client uses (`/api/push/apns/register`, `/api/permission/respond`).
enum PushManager {
    static let permissionCategory = "permission"
    static let allowAction = "ALLOW"
    static let denyAction = "DENY"

    /// The "permission" category carries Allow/Deny buttons (Android's notification action buttons).
    /// Other kinds (question/result/clear) are plain alerts — tap to open, matching Android, since a
    /// multiple-choice question can't be expressed as a pair of buttons.
    static func categories() -> Set<UNNotificationCategory> {
        let allow = UNNotificationAction(identifier: allowAction, title: "Allow", options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: denyAction, title: "Deny", options: [.destructive])
        let permission = UNNotificationCategory(
            identifier: permissionCategory,
            actions: [allow, deny],
            intentIdentifiers: [],
            options: []
        )
        return [permission]
    }

    static func register(token: String) {
        post("api/push/apns/register", body: ["token": token])
    }

    static func handle(response: UNNotificationResponse) {
        let info = response.notification.request.content.userInfo
        let sessionId = info["sessionId"] as? String
        let requestId = info["requestId"] as? String

        switch response.actionIdentifier {
        case allowAction:
            if let requestId { respond(requestId: requestId, decision: "allow") }
        case denyAction:
            if let requestId { respond(requestId: requestId, decision: "deny") }
        default:
            // Default tap (UNNotificationDefaultActionIdentifier) → open the session.
            if let sessionId { DeepLink.open(sessionId: sessionId) }
        }
    }

    private static func respond(requestId: String, decision: String) {
        post("api/permission/respond", body: ["requestId": requestId, "decision": decision])
    }

    /// Fire-and-forget JSON POST to the daemon, mirroring Android's Net.post.
    private static func post(_ path: String, body: [String: String]) {
        let url = AppConfig.baseURL.appendingPathComponent(path)
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req).resume()
    }
}
#endif
