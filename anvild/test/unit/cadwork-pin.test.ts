/**
 * [B1] Track A ↔ B pin wiring (merge item (b), src/session/cadwork-pin.ts): cad.status follows the
 * pin service, a pin advance rebuilds live parts under the new build (measured.solidcraft moves),
 * and the "Pin back" list is read from part files.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { wireCadPin } from "../../src/session/cadwork-pin";
import { BOX, cleanupTemp, fakeCadSession, stopServices, tempRepo, until } from "../helpers/cad-work";
import { FAKE_SOLIDCRAFT } from "../helpers/fake-solidcraft";

afterEach(async () => {
  await stopServices();
  cleanupTemp();
});

describe("cad pin wiring", () => {
  test("[B1] cad.status and tool refusals follow the pin; a pin advance rebuilds live parts so measured.solidcraft is the new build; pin back lists those designs", async () => {
    const repo = tempRepo();
    let version = "0.44.1";
    let pin: { available: boolean; reason?: string; pinned?: string } = { available: true, pinned: "0.44.1" };
    const x = fakeCadSession(repo, {
      resolveCli: () => ({ path: FAKE_SOLIDCRAFT, source: "env", version }),
      manager: { extraEnv: () => ({ FAKE_SC_VERSION: version }) },
    });
    const wiring = wireCadPin({ cadwork: x.service, pin: { availability: async () => pin }, roots: () => [{ path: repo, environment: "demo" }], serverName: "m4" });
    // Fail closed until the first verdict.
    expect(x.service.status().available).toBe(false);
    await wiring.onPinChanged();
    expect(x.service.status()).toMatchObject({ available: true, pinned: "0.44.1", version: "0.44.1" });

    expect((await x.tools.open_part!({ part: "plate" })).isError).toBe(false);
    expect((await x.tools.execute!({ command: "solid.box", params: BOX().params })).isError).toBe(false);
    await x.service.manager.forceRefresh(x.service.liveParts()[0]!);
    const partJson = join(repo, "cad", "plate", "part.json");
    expect(JSON.parse(readFileSync(partJson, "utf8")).measured.solidcraft).toBe("0.44.1");
    expect(wiring.rewrittenDesigns("0.44.1")).toEqual([{ part: "plate", version: "0.44.1", path: join(repo, "cad", "plate"), environment: "demo", serverName: "m4" }]);
    expect(wiring.rewrittenDesigns("0.45.0")).toEqual([]);

    // Off the pin: unavailable with the pin service's reason, broadcast, and every call refuses.
    pin = { available: false, reason: "CAD is unavailable here: this machine runs SolidCraft 0.44.1 but the fleet is pinned to 0.45.0", pinned: "0.45.0" };
    await wiring.onPinChanged();
    expect(x.service.status()).toMatchObject({ available: false, pinned: "0.45.0" });
    expect(x.broadcasts.filter((e: any) => e.type === "cad.status").at(-1)).toMatchObject({ available: false, reason: pin.reason });
    const refused = await x.tools.measure!({});
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(pin.reason!);

    // The machine installs the new pin: available again, and the live part is rebuilt under it.
    version = "0.45.0";
    pin = { available: true, pinned: "0.45.0" };
    await wiring.onPinChanged();
    expect(x.service.status()).toMatchObject({ available: true, version: "0.45.0" });
    await until(() => JSON.parse(readFileSync(partJson, "utf8")).measured?.solidcraft === "0.45.0", "measured.solidcraft to follow the new build");
    expect(wiring.rewrittenDesigns("0.45.0").map((d) => d.part)).toEqual(["plate"]);
  });
});
