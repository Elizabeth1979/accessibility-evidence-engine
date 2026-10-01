import { expect, test } from "@playwright/test";

import { createModelProvider, parseModelProviderName } from "@aee/ai-fixes";

import { formatScore, scoreNames } from "./ai-score";

/**
 * The models to score, from AEE_SCORE_PROVIDERS: provider names, each with an optional model after
 * a colon, such as "local claude openai:gpt-5-mini". Unset, the free local model is scored, and
 * Claude too when a key is set.
 */
function providersToScore(env = process.env) {
  const listed = env.AEE_SCORE_PROVIDERS?.split(/[\s,]+/).filter(Boolean) ?? [
    "local",
    ...(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? ["claude"] : [])
  ];
  return listed.map((entry) => {
    const [name = "", ...model] = entry.split(":");
    const provider = parseModelProviderName(name);
    if (!provider || provider === "stub" || provider === "auto") {
      throw new Error(`AEE_SCORE_PROVIDERS names models to score; "${entry}" is not one.`);
    }
    return { provider, model: model.join(":") || undefined };
  });
}

for (const { provider, model } of providersToScore()) {
  test(`${provider}${model ? `:${model}` : ""} names the lab's nameless controls`, async ({
    browser
  }, testInfo) => {
    const score = await scoreNames(
      browser,
      createModelProvider({ provider, env: { ...process.env, AEE_LLM_MODEL: model } }),
      testInfo
    );
    console.log(formatScore(score));
    // A model that answered nothing was not measured: its setup is broken.
    expect(
      score.answers.some(({ answer }) => answer !== undefined),
      "The model answered no question; see the notes above."
    ).toBe(true);
  });
}
