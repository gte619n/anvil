package com.zellijconnect.app

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper

/**
 * Discovers this device's wireless-debugging "connect" endpoint via mDNS
 * (`_adb-tls-connect._tcp`), so the Mac can `adb connect <ip>:<port>`. The connect port changes
 * every time Wireless debugging restarts — this grabs the current one. (First-time setup still
 * needs a one-off manual pairing; after that, reconnect is one tap.)
 */
class AdbWifi(context: Context) {
    private val nsd = context.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val main = Handler(Looper.getMainLooper())
    private var listener: NsdManager.DiscoveryListener? = null
    private var onResult: ((String, Int) -> Unit)? = null
    private var onError: ((String) -> Unit)? = null
    private val timeout = Runnable {
        fail("No wireless-debugging service found. Turn on Wireless debugging in Developer options, then retry.")
    }

    fun discover(onResult: (host: String, port: Int) -> Unit, onError: (String) -> Unit) {
        stop()
        this.onResult = onResult
        this.onError = onError
        main.postDelayed(timeout, 8_000)
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(t: String) {}
            override fun onDiscoveryStopped(t: String) {}
            override fun onStartDiscoveryFailed(t: String, e: Int) = fail("Couldn't start discovery ($e)")
            override fun onStopDiscoveryFailed(t: String, e: Int) {}
            override fun onServiceLost(s: NsdServiceInfo) {}
            override fun onServiceFound(s: NsdServiceInfo) {
                try {
                    @Suppress("DEPRECATION")
                    nsd.resolveService(s, resolveListener())
                } catch (_: Exception) {
                }
            }
        }
        listener = l
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, l)
        } catch (e: Exception) {
            fail("Couldn't start discovery: ${e.message}")
        }
    }

    private fun resolveListener() = object : NsdManager.ResolveListener {
        override fun onResolveFailed(si: NsdServiceInfo, e: Int) {} // keep waiting for another service
        override fun onServiceResolved(si: NsdServiceInfo) {
            val host = si.host?.hostAddress ?: return fail("Couldn't resolve the device address.")
            succeed(host, si.port)
        }
    }

    private fun succeed(host: String, port: Int) {
        val cb = onResult ?: return
        cleanup()
        main.post { cb(host, port) }
    }

    private fun fail(msg: String) {
        val cb = onError ?: return
        cleanup()
        main.post { cb(msg) }
    }

    private fun cleanup() {
        main.removeCallbacks(timeout)
        onResult = null
        onError = null
        stop()
    }

    fun stop() {
        listener?.let { runCatching { nsd.stopServiceDiscovery(it) } }
        listener = null
    }

    companion object {
        const val SERVICE_TYPE = "_adb-tls-connect._tcp."
    }
}
