package com.gte619n.anvil

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.widget.FrameLayout
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationManagerCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Anvil Android shell (hybrid, stage 1): a hardened WebView hosting the Anvil web client over
 * Tailscale. Native modules (ADB-wifi mDNS discovery, FCM push) layer on in later stages.
 */
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val adbWifi by lazy { AdbWifi(this) }

    private val notifPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* result ignored */ }

    private val fileChooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            filePathCallback?.onReceiveValue(uris ?: emptyArray())
            filePathCallback = null
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // Serve the bundled web client from assets/web over a secure local origin. The UI shell +
        // fonts always load offline; only the daemon data connection (WS/REST over Tailscale) needs
        // the network, and the web app degrades gracefully when it's down.
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/", AssetsWebHandler(this))
            .build()

        web = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                @Suppress("DEPRECATION")
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = false
                allowContentAccess = false
                cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
            }
            setBackgroundColor(themeBackground())
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assetLoader.shouldInterceptRequest(request.url)

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val host = request.url.host ?: return false
                    if (host == ASSET_HOST) return false // our bundled UI stays in the app
                    startActivity(Intent(Intent.ACTION_VIEW, request.url)) // external/daemon links → browser
                    return true
                }
            }
            // Inject the daemon URL before any page script runs, so the bundled UI knows where the
            // daemon is (the page itself is served locally, not from the daemon).
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                val js = "window.ANVIL_DAEMON_URL=${JSONObject.quote(BuildConfig.ANVIL_BASE_URL)};"
                WebViewCompat.addDocumentStartJavaScript(this, js, setOf("https://$ASSET_HOST"))
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    view: WebView,
                    callback: ValueCallback<Array<Uri>>,
                    params: FileChooserParams,
                ): Boolean {
                    filePathCallback?.onReceiveValue(null)
                    filePathCallback = callback
                    return try {
                        fileChooser.launch(params.createIntent())
                        true
                    } catch (_: Exception) {
                        filePathCallback = null
                        false
                    }
                }

                override fun onPermissionRequest(request: PermissionRequest) = request.deny()
            }
        }
        // Root painted with the theme-correct background (no white flash; correct dark/light from
        // the first frame). Padding it by the system bars physically insets the WebView so app
        // content never sits under the status/nav bars.
        val root = FrameLayout(this).apply { setBackgroundColor(themeBackground()) }
        root.addView(web)
        setContentView(root)
        WindowInsetsControllerCompat(window, root).isAppearanceLightStatusBars = !isDark()
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(root)

        // Native bridge: the bundled UI posts {type:"adb.connect"} → we discover the
        // wireless-debugging endpoint and tell the daemon to `adb connect`, then reply.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "AnvilNative", setOf("https://$ASSET_HOST")) { _, message, _, _, replyProxy ->
                handleBridge(message.data ?: "", replyProxy)
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) {
                    web.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        // Push (FCM): notification channel, runtime permission, and register this device's token.
        Notifications.ensureChannel(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            Net.postJson(BuildConfig.ANVIL_BASE_URL, "/api/push/fcm/register", JSONObject().put("token", token))
        }

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState)
        } else {
            val sessionId = intent?.getStringExtra("sessionId") // notification-tap deep link
            if (sessionId != null) openSession(sessionId) else web.loadUrl(APP_URL)
        }
    }

    private fun isDark(): Boolean =
        resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES

    private fun themeBackground(): Int = if (isDark()) 0xFF1A1B1E.toInt() else 0xFFFFFFFF.toInt()

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra("sessionId")?.let { openSession(it) }
    }

    /** Open a session from a notification tap and clear that session's reminder — entering the
     *  session is the user acting on it, so the shade entry (even an ongoing permission one) goes. */
    private fun openSession(sessionId: String) {
        web.loadUrl(sessionUrl(sessionId))
        NotificationManagerCompat.from(this).cancel(sessionId.hashCode())
    }

    private fun sessionUrl(sessionId: String): String = "$APP_URL#s/${Uri.encode(sessionId)}"

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    private fun handleBridge(data: String, reply: JavaScriptReplyProxy) {
        val json = runCatching { JSONObject(data) }.getOrNull()
        when (json?.optString("type")) {
            "adb.connect" -> adbWifi.discover(
                AdbWifi.CONNECT,
                onResult = { lanHost, port ->
                    val host = tailscaleIp() ?: lanHost // prefer the tailnet IP (LAN subnets often differ)
                    postAdb("/api/adb/connect", JSONObject().put("host", host).put("port", port), reply, "connect", host, port)
                },
                onError = { msg -> replyBridge(reply, false, msg, "connect") },
            )
            "adb.pair" -> {
                val code = json.optString("code")
                adbWifi.discover(
                    AdbWifi.PAIRING,
                    onResult = { lanHost, port ->
                        val host = tailscaleIp() ?: lanHost
                        postAdb("/api/adb/pair", JSONObject().put("host", host).put("port", port).put("code", code), reply, "pair", host, port)
                    },
                    onError = { msg -> replyBridge(reply, false, msg, "pair") },
                )
            }
            else -> replyBridge(reply, false, "Unknown native command", "")
        }
    }

    /** This device's Tailscale IPv4 (CGNAT 100.64.0.0/10), if Tailscale is up — reachable from the
     *  Mac across subnets, unlike the phone's LAN IP. */
    private fun tailscaleIp(): String? = try {
        java.net.NetworkInterface.getNetworkInterfaces().asSequence()
            .flatMap { it.inetAddresses.asSequence() }
            .filterIsInstance<java.net.Inet4Address>()
            .firstOrNull { val b = it.address; (b[0].toInt() and 0xFF) == 100 && (b[1].toInt() and 0xFF) in 64..127 }
            ?.hostAddress
    } catch (_: Exception) {
        null
    }

    private fun postAdb(path: String, body: JSONObject, reply: JavaScriptReplyProxy, stage: String, host: String, port: Int) {
        Thread {
            try {
                val base = BuildConfig.ANVIL_BASE_URL.trimEnd('/')
                val conn = (URL("$base$path").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    doOutput = true
                    connectTimeout = 8_000
                    readTimeout = 20_000
                    setRequestProperty("Content-Type", "application/json")
                }
                conn.outputStream.use { it.write(body.toString().toByteArray()) }
                val code = conn.responseCode
                val resp = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
                val parsed = runCatching { JSONObject(resp) }.getOrNull()
                val out = parsed?.optString("output", resp) ?: resp
                val ok = code in 200..299 && (parsed?.optBoolean("ok") ?: false)
                val verb = if (stage == "pair") "Paired" else "Connected"
                replyBridge(reply, ok, if (ok) "$verb $host:$port — $out" else "$host:$port → $out", stage)
            } catch (e: Exception) {
                replyBridge(reply, false, "Couldn't reach the server: ${e.message}", stage)
            }
        }.start()
    }

    private fun replyBridge(reply: JavaScriptReplyProxy, ok: Boolean, message: String, stage: String) {
        val json = JSONObject().put("type", "adb.result").put("ok", ok).put("stage", stage).put("message", message).toString()
        runOnUiThread {
            runCatching { reply.postMessage(json) }
            Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        }
    }

    companion object {
        const val ASSET_HOST = "appassets.androidplatform.net" // WebViewAssetLoader's secure origin
        const val APP_URL = "https://$ASSET_HOST/index.html"
    }
}

/** Serves the bundled web client from assets/web/ (so "/" → assets/web/index.html, "/main.js" →
 *  assets/web/main.js). Lets the UI use absolute paths while living under an assets subdir. */
private class AssetsWebHandler(context: android.content.Context) : WebViewAssetLoader.PathHandler {
    private val assets = context.assets
    override fun handle(path: String): WebResourceResponse? {
        val rel = "web/" + path.removePrefix("/").ifEmpty { "index.html" }
        return try {
            val mime = guessMime(rel)
            WebResourceResponse(mime, null, assets.open(rel))
        } catch (_: java.io.FileNotFoundException) {
            null
        } catch (_: Exception) {
            null
        }
    }

    private fun guessMime(p: String): String = when (p.substringAfterLast('.', "")) {
        "html" -> "text/html"
        "js", "mjs" -> "text/javascript"
        "css" -> "text/css"
        "json", "map" -> "application/json"
        "svg" -> "image/svg+xml"
        "woff2" -> "font/woff2"
        "png" -> "image/png"
        "wasm" -> "application/wasm"
        else -> "application/octet-stream"
    }
}
