import { describe, it } from "node:test";
import assert from "node:assert";
import {
  classifyCloudError,
  resetCloudPolicyState,
  runCloudAgentWithPolicy,
} from "./cloud-policy.js";

describe("classifyCloudError", () => {
  it("classifie plan_required comme non retryable", () => {
    const result = classifyCloudError(new Error("[plan_required] Upgrade to Ultra"));
    assert.strictEqual(result.retryable, false);
  });

  it("classifie 429 comme retryable", () => {
    const result = classifyCloudError(new Error("HTTP 429 rate limit exceeded"));
    assert.strictEqual(result.retryable, true);
  });
});

describe("runCloudAgentWithPolicy", () => {
  it("retry une erreur retryable puis réussit", async () => {
    resetCloudPolicyState();
    let attempts = 0;
    const result = await runCloudAgentWithPolicy(
      async () => {
        attempts++;
        if (attempts === 1) throw new Error("429 rate limit");
        return "ok";
      },
      { CLOUD_AGENT_MAX_RETRIES: "2", CLOUD_AGENT_COOLDOWN_MS: "0" },
      "test",
    );
    assert.strictEqual(result, "ok");
    assert.strictEqual(attempts, 2);
  });

  it("n'essaie pas de retry une erreur non retryable", async () => {
    resetCloudPolicyState();
    let attempts = 0;
    await assert.rejects(async () => {
      await runCloudAgentWithPolicy(
        async () => {
          attempts++;
          throw new Error("[validation_error] invalid payload");
        },
        { CLOUD_AGENT_MAX_RETRIES: "3", CLOUD_AGENT_COOLDOWN_MS: "0" },
        "test",
      );
    });
    assert.strictEqual(attempts, 1);
  });
});
