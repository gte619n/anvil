/**
 * [WEB2-18 / WEB2-8] Guard tests for the dialogs seam (dialogs.ts).
 *   - confirmDialog (via the shared modalPromise primitive) renders a real dialog for assistive
 *     tech: [role="dialog"][aria-modal="true"] on the modal box;
 *   - the showModal focus trap: focus moves into the dialog on open, Tab from the LAST focusable
 *     wraps to the first (and Shift+Tab from the first wraps to the last), and closing the dialog
 *     restores focus to the element that opened it;
 *   - the modal-promise contract survives the WEB2-18 collapse: an explicit choice resolves with
 *     that value, and dismissing the layer any other way resolves the cancel value (never hangs);
 *   - the inline permission/question cards announce themselves (role="alert").
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";
import type { PermissionSuggestion, Question } from "../../protocol";

let dialogs: typeof import("../../web/src/dialogs");

const HTML = `<!doctype html><html><body>
  <button id="opener">open</button>
  <div id="modal-root"></div>
  <div id="menu-root"></div>
  <div id="toast"></div>
  <div id="conversation"></div>
</body></html>`;

beforeAll(async () => {
  installDom({ html: HTML });
  // jsdom doesn't implement scrollIntoView (showQuestion pins the card top) — stub it.
  (window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  dialogs = await import("../../web/src/dialogs");
  // Minimal injected deps — only what the exercised paths (cards) actually reach.
  dialogs.initDialogs({
    activeId: () => "s1",
    sessions: new Map(),
    environments: new Map(),
    selectSession: () => {},
    persistSessions: () => {},
    enqueue: () => {},
    sendAwait: (async () => ({ type: "command.ok" })) as never,
    HUB_URL: "http://hub",
    servers: new Map(),
    hub: (() => ({})) as never,
    orderedServers: () => [],
    envServer: new Map(),
    serverOfEnv: (() => ({})) as never,
    sessionServer: new Map(),
    persistRouting: () => {},
    sendTo: () => true,
    openSettings: () => {},
    closeSettings: () => {},
    loadTodoistProjects: async () => {},
    todoistProjectOptions: () => "",
    todoistProjectLinks: () => new Map(),
    todoistProjectName: () => undefined,
    conversation: document.getElementById("conversation")!,
    dropSessionHero: () => {},
    hideThinking: () => {},
    showThinking: () => {},
    scrollDown: () => {},
  });
});
afterAll(() => uninstallDom());

const tab = (target: Element, shiftKey = false): void => {
  target.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));
};

test("confirmDialog renders [role=dialog][aria-modal=true] and traps + restores focus", async () => {
  const opener = document.getElementById("opener")!;
  opener.focus();
  const p = dialogs.confirmDialog({ title: "Remove?", body: "Gone for good.", danger: true });

  const box = document.querySelector<HTMLElement>('#modal-root [role="dialog"]');
  expect(box).not.toBeNull();
  expect(box!.getAttribute("aria-modal")).toBe("true");

  // Focus moved INTO the dialog on open (danger → the safe Cancel button gets it).
  const cancel = document.getElementById("cd-cancel")!;
  const ok = document.getElementById("cd-ok")!;
  expect(document.activeElement).toBe(cancel);

  // Tab from the LAST focusable wraps to the first…
  ok.focus();
  tab(ok);
  expect(document.activeElement).toBe(cancel);
  // …and Shift+Tab from the first wraps back to the last.
  tab(cancel, true);
  expect(document.activeElement).toBe(ok);

  // An explicit confirm resolves true, tears the dialog down, and hands focus back to the opener.
  (ok as HTMLButtonElement).click();
  expect(await p).toBe(true);
  expect(document.querySelector("#modal-root .modal")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

test("dismissing the modal layer resolves the cancel value (the caller never hangs)", async () => {
  const p = dialogs.confirmDialog({ title: "Sure?" });
  dialogs.closeModal(); // Escape / device Back / programmatic close — not a button press
  expect(await p).toBe(false);

  const p2 = dialogs.pickListDialog("Pick", [{ id: "a", label: "A" }]);
  dialogs.closeModal();
  expect(await p2).toBeNull();

  const p3 = dialogs.confirmDialogWithOption({ title: "Sure?", optionLabel: "Also this" });
  dialogs.closeModal();
  expect(await p3).toEqual({ ok: false, checked: false });
});

test("pickListDialog resolves the clicked item's id through the shared primitive", async () => {
  const p = dialogs.pickListDialog("Pick", [
    { id: "one", label: "One" },
    { id: "two", label: "Two" },
  ]);
  document.querySelector<HTMLElement>('.pick-item[data-id="two"]')!.click();
  expect(await p).toBe("two");
});

test("permission and question cards carry role=alert", () => {
  const conversation = document.getElementById("conversation")!;
  dialogs.showPermission("req1", "Bash", { command: "ls" }, [{ decision: "allow", label: "Allow" }] as unknown as PermissionSuggestion[]);
  const perm = conversation.querySelector(".bubble.permission");
  expect(perm).not.toBeNull();
  expect(perm!.getAttribute("role")).toBe("alert");
  dialogs.resolvePermissionUI("req1");

  dialogs.showQuestion("q1", [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] as unknown as Question[]);
  const q = conversation.querySelector(".bubble.question");
  expect(q).not.toBeNull();
  expect(q!.getAttribute("role")).toBe("alert");
  dialogs.resolveQuestionUI("q1", "A");
});
