package com.gte619n.anvil

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Settings

/**
 * Flips the Wireless-debugging toggle programmatically, so starting a debug session never needs the
 * Settings → Developer options round-trip (Android resets the toggle on every reboot).
 *
 * The switch lives behind WRITE_SECURE_SETTINGS, which can't be requested at runtime — but a
 * one-time grant from any adb session sticks across reboots and app updates:
 *
 *     adb shell pm grant com.gte619n.anvil android.permission.WRITE_SECURE_SETTINGS
 *
 * The daemon issues that grant itself on every successful auto-connect (see adb.ts), so after the
 * first manual connect the loop closes: app turns the toggle on → mDNS discovers the fresh port →
 * daemon connects and re-pins :5555 — all silent.
 */
object AdbToggle {
    private const val ADB_WIFI_ENABLED = "adb_wifi_enabled" // hidden Settings.Global key, Android 11+

    fun canToggle(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED

    fun isOn(context: Context): Boolean =
        Settings.Global.getInt(context.contentResolver, ADB_WIFI_ENABLED, 0) == 1

    /** Turn Wireless debugging on. True when the toggle is on (already, or just flipped); false when
     *  it's off and we lack the grant to flip it. adbd starts advertising its mDNS service within a
     *  second or two of the write — well inside AdbWifi's 8s discovery window. */
    fun ensureOn(context: Context): Boolean {
        if (isOn(context)) return true
        if (!canToggle(context)) return false
        return try {
            // Developer options must be live or some OEMs ignore the wifi toggle.
            Settings.Global.putInt(context.contentResolver, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 1)
            Settings.Global.putInt(context.contentResolver, ADB_WIFI_ENABLED, 1)
        } catch (_: SecurityException) {
            false
        }
    }
}
