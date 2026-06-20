package com.zellijconnect.app

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
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

    private val fileChooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            filePathCallback?.onReceiveValue(uris ?: emptyArray())
            filePathCallback = null
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

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
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val host = request.url.host ?: return false
                    if (host == BASE_HOST) return false // keep our origin in the app
                    startActivity(Intent(Intent.ACTION_VIEW, request.url)) // external links → browser
                    return true
                }
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
        setContentView(web)

        // Native bridge: the web app (Settings) posts {type:"adb.connect"} → we discover the
        // wireless-debugging endpoint and tell the daemon to `adb connect`, then reply.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            val uri = Uri.parse(BuildConfig.ANVIL_BASE_URL)
            val origin = buildString {
                append(uri.scheme).append("://").append(uri.host)
                if (uri.port != -1) append(":").append(uri.port)
            }
            WebViewCompat.addWebMessageListener(web, "AnvilNative", setOf(origin)) { _, message, _, _, replyProxy ->
                handleBridge(message.data ?: "", replyProxy)
            }
        }

        // targetSdk 35 forces edge-to-edge; pad the WebView by the system bars + keyboard so the
        // composer rides above the keyboard and content clears the status/nav bars.
        ViewCompat.setOnApplyWindowInsetsListener(web) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
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

        if (savedInstanceState == null) web.loadUrl(BuildConfig.ANVIL_BASE_URL) else web.restoreState(savedInstanceState)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    private fun handleBridge(data: String, reply: JavaScriptReplyProxy) {
        val type = runCatching { JSONObject(data).optString("type") }.getOrDefault("")
        when (type) {
            "adb.connect" -> adbWifi.discover(
                onResult = { host, port -> postAdbConnect(host, port, reply) },
                onError = { msg -> replyBridge(reply, false, msg) },
            )
            else -> replyBridge(reply, false, "Unknown native command")
        }
    }

    private fun postAdbConnect(host: String, port: Int, reply: JavaScriptReplyProxy) {
        Thread {
            try {
                val base = BuildConfig.ANVIL_BASE_URL.trimEnd('/')
                val conn = (URL("$base/api/adb/connect").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    doOutput = true
                    connectTimeout = 8_000
                    readTimeout = 12_000
                    setRequestProperty("Content-Type", "application/json")
                }
                conn.outputStream.use { it.write(JSONObject().put("host", host).put("port", port).toString().toByteArray()) }
                val code = conn.responseCode
                val body = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
                val parsed = runCatching { JSONObject(body) }.getOrNull()
                val out = parsed?.optString("output", body) ?: body
                val ok = code in 200..299 && (parsed?.optBoolean("ok") ?: false)
                replyBridge(reply, ok, if (ok) "Connected $host:$port → $out" else "ADB: $out")
            } catch (e: Exception) {
                replyBridge(reply, false, "Couldn't reach the server: ${e.message}")
            }
        }.start()
    }

    private fun replyBridge(reply: JavaScriptReplyProxy, ok: Boolean, message: String) {
        val json = JSONObject().put("type", "adb.result").put("ok", ok).put("message", message).toString()
        runOnUiThread {
            runCatching { reply.postMessage(json) }
            Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        }
    }

    companion object {
        val BASE_HOST: String? = Uri.parse(BuildConfig.ANVIL_BASE_URL).host
    }
}
