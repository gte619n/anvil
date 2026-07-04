import { test, expect } from "bun:test";
import { spawnInGroup, killGroup, groupAlive, type Group } from "../../src/session/procgroup";

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("killGroup reaps the whole process group, including grandchildren", async () => {
  // sh stays as the group leader; `sleep` runs as a child in the same group.
  // This is the regression guard for the orphaned-grandchild bug (da870d5).
  const g = spawnInGroup("sh", ["-c", "sleep 30 & wait"]);
  await tick(100);
  expect(groupAlive(g.pgid)).toBe(true);

  await killGroup(g, 1500);
  await tick(100);
  expect(groupAlive(g.pgid)).toBe(false);
});

test("killGroup on an already-dead group is a no-op", async () => {
  const g = spawnInGroup("sh", ["-c", "exit 0"]);
  await g.exited;
  await tick(50);
  await killGroup(g, 500); // must not throw
  expect(groupAlive(g.pgid)).toBe(false);
});

test("[BE-10] killGroup does NOT signal a pgid once our tracked child has exited (PID-reuse guard)", async () => {
  // A live, unrelated group that must never be touched.
  const bystander = spawnInGroup("sh", ["-c", "sleep 30 & wait"]);
  await tick(100);
  expect(groupAlive(bystander.pgid)).toBe(true);

  // Simulate: OUR child already exited and its pid (== pgid) was recycled by the bystander's group.
  const ourExitedGroup: Group = {
    pid: bystander.pgid,
    pgid: bystander.pgid,
    child: { exitCode: 0, signalCode: null } as unknown as Group["child"],
    exited: Promise.resolve(0),
  };
  await killGroup(ourExitedGroup, 500);
  await tick(50);
  // The bystander group is untouched — the guard prevented a foreign kill.
  expect(groupAlive(bystander.pgid)).toBe(true);

  await killGroup(bystander, 1500); // cleanup
});
