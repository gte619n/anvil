/**
 * A real Chrome-shaped cookie database for the agent-browser tests (Phase C3): `<profile>/Default/
 * Cookies`, a SQLite file with a `cookies` table. Only the columns the daemon reads are created.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { cookieDbPath } from "../../src/browser/loggedin";

let stamp = 13_400_000_000_000; // (kept under 2^53 so each cookie gets a distinct time)

/** Add cookies to the profile's database (created on first use). Each entry is `[host_key, name]`. */
export function addCookies(profileDir: string, cookies: [host: string, name: string][]): void {
  const file = cookieDbPath(profileDir);
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.run("create table if not exists cookies (creation_utc integer not null, host_key text not null, name text not null, value text not null default '', path text not null default '/')");
    const ins = db.prepare("insert into cookies (creation_utc, host_key, name, value, path) values (?, ?, ?, 'v', '/')");
    for (const [host, name] of cookies) ins.run(stamp++, host, name);
  } finally {
    db.close();
  }
}

/** Set a cookie again with a new value, the way a login replaces an anonymous session cookie. */
export function resetCookie(profileDir: string, host: string, name: string): void {
  const db = new Database(cookieDbPath(profileDir));
  try {
    db.prepare("update cookies set value = 'v2', creation_utc = ? where host_key = ? and name = ?").run(stamp++, host, name);
  } finally {
    db.close();
  }
}
