package com.gte619n.anvil

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Seed unit-test target for the Android shell (plain JVM JUnit, `:app:testDebugUnitTest` — wired
 * into the CI2-1 PR job). Exercises [guessMime], the MIME resolver AssetsWebHandler uses to serve
 * the bundled web client: a wrong mapping here means the WebView refuses to execute the app's own
 * JS/CSS/WASM. Grow the suite from here.
 */
class GuessMimeTest {
    @Test fun mapsTheBundledWebAssetTypes() {
        assertEquals("text/html", guessMime("web/index.html"))
        assertEquals("text/javascript", guessMime("web/main.js"))
        assertEquals("text/javascript", guessMime("web/chunk.mjs"))
        assertEquals("text/css", guessMime("web/styles/app.css"))
        assertEquals("application/json", guessMime("web/manifest.json"))
        assertEquals("application/json", guessMime("web/main.js.map"))
        assertEquals("image/svg+xml", guessMime("web/icon.svg"))
        assertEquals("font/woff2", guessMime("web/fonts/msym.woff2"))
        assertEquals("image/png", guessMime("web/icon-512.png"))
        assertEquals("application/wasm", guessMime("web/mod.wasm"))
    }

    @Test fun unknownAndExtensionlessPathsFallBackToOctetStream() {
        assertEquals("application/octet-stream", guessMime("web/README"))
        assertEquals("application/octet-stream", guessMime("web/archive.tar.gz"))
        assertEquals("application/octet-stream", guessMime(""))
    }
}
