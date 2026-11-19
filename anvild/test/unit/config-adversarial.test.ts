import { test, expect } from "bun:test";
import { loadConfig } from "../../src/config";

// loadConfig derives the adversarial-panel settings from the environment. These lock the defaults and
// the enable/disable logic so the feature stays inert without a key and opts in cleanly with one.

test("no OpenRouter key → panel disabled, models still defaulted", () => {
  const cfg = loadConfig({ HOME: "/tmp" });
  expect(cfg.adversarialEnabled).toBe(false);
  expect(cfg.openRouterApiKey).toBeUndefined();
  // GLM 5.2 is the default second critic; Gemini (direct when GEMINI_API_KEY is set) the third.
  expect(cfg.adversarialModels).toEqual(["openai/gpt-5-codex", "z-ai/glm-5.2", "gemini/gemini-4-argon"]);
  expect(cfg.adversarialProvider).toBeUndefined();
});

test("a Gemini key alone also enables the panel", () => {
  expect(loadConfig({ HOME: "/tmp", GEMINI_API_KEY: "AIza-x" }).adversarialEnabled).toBe(true);
});

test("a key enables the panel; ANVIL_ADVERSARIAL=0 is a kill switch", () => {
  expect(loadConfig({ HOME: "/tmp", OPENROUTER_API_KEY: "sk-or-x" }).adversarialEnabled).toBe(true);
  expect(loadConfig({ HOME: "/tmp", OPENROUTER_API_KEY: "sk-or-x", ANVIL_ADVERSARIAL: "0" }).adversarialEnabled).toBe(false);
});

test("models and provider are parsed from the environment", () => {
  const cfg = loadConfig({
    HOME: "/tmp",
    OPENROUTER_API_KEY: "sk-or-x",
    ANVIL_ADVERSARIAL_MODELS: " a/one , b/two ",
    ANVIL_ADVERSARIAL_PROVIDER: " deepinfra ",
  });
  expect(cfg.adversarialModels).toEqual(["a/one", "b/two"]); // trimmed, comma-split
  expect(cfg.adversarialProvider).toBe("deepinfra");
});
