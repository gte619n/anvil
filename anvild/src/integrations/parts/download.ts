/**
 * The daemon's own download for `parts_fetch` (Phase C5). Not a general fetcher: the caller has
 * already checked that the URL came from a `parts_search` result. Here:
 *
 *  - https only, on the first URL and on every redirect (at most 5);
 *  - every hop is vetted the way the browser's proxy vets a connection (`vetTarget`: resolve the name,
 *    check EVERY address against loopback / private / link-local / tailnet / this machine / the fleet)
 *    and the connection goes to the address that was checked — never a second lookup (no DNS
 *    rebinding between check and connect). TLS still verifies the certificate for the hostname;
 *  - the size cap is enforced while streaming (a missing or lying Content-Length does not help), and
 *    a partial file is deleted;
 *  - the file's type is decided from its name before a byte is written.
 */
import { createWriteStream, unlinkSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { request } from "node:https";
import { isIP } from "node:net";
import { vetTarget, type ProxyResolver } from "../../browser/proxy";
import { PartSourceError } from "./types";

export interface PartDownloadDeps {
  resolver: ProxyResolver;
  /** This machine's names and addresses, and the fleet's: refused whatever they resolve to. */
  selfHosts: () => readonly string[];
  fleetHosts: () => readonly string[];
  /** TEST SEAM: where a vetted address is actually dialled (a fixture server on loopback). */
  dial?: (address: string, port: number) => { address: string; port: number };
  /** TEST SEAM: extra trusted CA (a fixture's self-signed certificate). */
  ca?: string;
  /** Whole-download timeout (default 5 minutes). */
  timeoutMs?: number;
}

export interface DownloadedFile {
  finalUrl: string;
  size: number;
  /** The server's suggested name (Content-Disposition), else the last path segment. */
  name: string;
}

const MAX_REDIRECTS = 5;

/** The file name a response suggests. */
export function suggestedName(res: Pick<IncomingMessage, "headers">, url: URL): string {
  const cd = String(res.headers["content-disposition"] ?? "");
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(cd)?.[1];
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(cd)?.[1];
  let name = "";
  try {
    name = star ? decodeURIComponent(star.trim()) : (plain?.trim() ?? "");
  } catch {
    name = plain?.trim() ?? "";
  }
  if (!name) {
    try {
      name = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
    } catch {
      name = url.pathname.split("/").filter(Boolean).pop() ?? "";
    }
  }
  return name || "download";
}

/** One GET to an already-vetted address. */
function get(url: URL, address: string, port: number, deps: PartDownloadDeps, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((done, fail) => {
    const family = isIP(address) || 4;
    const req = request({
      host: url.hostname, // TLS verifies the certificate for this name …
      servername: isIP(url.hostname) ? undefined : url.hostname,
      port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { "user-agent": "Anvil-parts_fetch/1", accept: "*/*", "accept-encoding": "identity" },
      agent: false,
      // … but the socket goes to the address that was checked, not to a fresh lookup.
      lookup: ((_h: string, o: { all?: boolean } | undefined, cb: (...a: unknown[]) => void) => (o && o.all ? cb(null, [{ address, family }]) : cb(null, address, family))) as never,
      ...(deps.ca ? { ca: deps.ca } : {}),
      signal,
    });
    req.once("response", done);
    req.once("error", fail);
    req.end();
  });
}

/**
 * Download `startUrl` into `destFor(name)` (called once the final response is known, with its
 * suggested name; it returns the path to write, or throws to refuse the type). Never more than
 * `maxBytes` is written; on any failure nothing is left on disk.
 */
export async function downloadPart(startUrl: string, maxBytes: number, destFor: (name: string) => string, deps: PartDownloadDeps): Promise<DownloadedFile & { path: string }> {
  const signal = AbortSignal.timeout(deps.timeoutMs ?? 5 * 60_000);
  let url: URL;
  try {
    url = new URL(startUrl);
  } catch {
    throw new PartSourceError("refused", "that is not a URL");
  }
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "https:") throw new PartSourceError("refused", hop ? `it redirected to ${url.protocol}//${url.host}, and only https is followed` : "only https URLs are fetched");
    const port = url.port ? Number(url.port) : 443;
    const verdict = await vetTarget(url.hostname, port, { resolve: deps.resolver, fleetHosts: deps.fleetHosts, selfHosts: deps.selfHosts, allowedLoopbackPorts: new Set() });
    if (!verdict.ok) throw new PartSourceError("refused", `${hop ? "it redirected to an address that is not allowed" : "that address is not allowed"}: ${verdict.reason}`);
    const target = deps.dial ? deps.dial(verdict.address, port) : { address: verdict.address, port };
    let res: IncomingMessage;
    try {
      res = await get(url, target.address, target.port, deps, signal);
    } catch (e) {
      throw new PartSourceError(signal.aborted ? "timeout" : "network", signal.aborted ? "the download took too long" : `the download failed (${e instanceof Error ? e.message : String(e)})`);
    }
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= MAX_REDIRECTS) throw new PartSourceError("refused", `more than ${MAX_REDIRECTS} redirects`);
      try {
        url = new URL(res.headers.location, url);
      } catch {
        throw new PartSourceError("refused", "it redirected to something that is not a URL");
      }
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new PartSourceError("http", `the server answered HTTP ${status}`);
    }
    const declared = Number(res.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.destroy();
      throw new PartSourceError("refused", `it is ${declared} bytes, over the ${maxBytes}-byte limit; nothing was saved`);
    }
    const name = suggestedName(res, url);
    let path: string;
    try {
      path = destFor(name);
    } catch (e) {
      res.destroy();
      throw e;
    }
    const size = await new Promise<number>((done, fail) => {
      const out = createWriteStream(path, { flags: "wx", mode: 0o600 });
      let n = 0;
      let failed = false;
      const abort = (err: PartSourceError): void => {
        if (failed) return;
        failed = true;
        res.destroy();
        const unlink = (): void => {
          try {
            unlinkSync(path);
          } catch {
            /* not created */
          }
        };
        // The stream opens its file asynchronously: an abort before the open finished would unlink
        // nothing and the open would then create the file. So delete again once it has closed, and
        // report the failure only then (a close that never comes still fails after 2 s).
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          unlink();
          fail(err);
        };
        unlink();
        out.once("close", finish);
        setTimeout(finish, 2000).unref?.();
        out.destroy();
        if (out.closed) finish();
      };
      res.on("data", (chunk: Buffer) => {
        n += chunk.length;
        if (n > maxBytes) return abort(new PartSourceError("refused", `it is over the ${maxBytes}-byte limit; the download was stopped and the partial file deleted`));
        if (!out.write(chunk)) {
          res.pause();
          out.once("drain", () => res.resume());
        }
      });
      res.once("error", (e: Error) => abort(new PartSourceError(signal.aborted ? "timeout" : "network", signal.aborted ? "the download took too long; the partial file was deleted" : `the download failed (${e.message}); the partial file was deleted`)));
      res.once("aborted", () => abort(new PartSourceError("network", "the server closed the connection early; the partial file was deleted")));
      out.once("error", (e) => abort(new PartSourceError("network", `could not write the file (${e.message})`)));
      res.once("end", () => {
        if (failed) return;
        out.end(() => done(n));
      });
    });
    return { finalUrl: url.href, size, name, path };
  }
}
