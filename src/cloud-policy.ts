type RetryClassification = {
  retryable: boolean;
  reason: string;
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function flattenErrorMessages(error: unknown): string {
  const chunks: string[] = [];
  let current: unknown = error;
  let depth = 0;
  while (current && depth < 5) {
    if (current instanceof Error) {
      chunks.push(current.message ?? "");
      current = (current as Error & { cause?: unknown }).cause;
      depth++;
      continue;
    }
    chunks.push(String(current));
    break;
  }
  return chunks.join(" | ").toLowerCase();
}

export function classifyCloudError(error: unknown): RetryClassification {
  const maybeRetryable = error as { isRetryable?: boolean };
  if (maybeRetryable?.isRetryable === true) {
    return { retryable: true, reason: "sdk_isRetryable" };
  }

  const message = flattenErrorMessages(error);
  if (
    message.includes("validation_error")
    || message.includes("plan_required")
    || message.includes("feature_unavailable")
    || message.includes("upgrade to ultra")
    || message.includes("unauthorized")
    || message.includes("forbidden")
    || message.includes(" api responded 401")
    || message.includes(" api responded 403")
  ) {
    return { retryable: false, reason: "non_retryable_plan_or_auth" };
  }

  if (
    message.includes("429")
    || message.includes("rate limit")
    || message.includes("rate_limit")
    || message.includes("network")
    || message.includes("timeout")
    || message.includes("timed out")
    || message.includes("econnreset")
    || message.includes("5xx")
    || message.includes("service unavailable")
    || message.includes("bad gateway")
  ) {
    return { retryable: true, reason: "retryable_rate_or_network" };
  }

  return { retryable: false, reason: "default_non_retryable" };
}

let lastCloudSubmissionAt = 0;

export function resetCloudPolicyState(): void {
  lastCloudSubmissionAt = 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runCloudAgentWithPolicy<T>(
  run: () => Promise<T>,
  env: NodeJS.ProcessEnv,
  logPrefix: string,
): Promise<T> {
  const cooldownMs = parsePositiveInt(env.CLOUD_AGENT_COOLDOWN_MS, 1500);
  const maxRetries = parsePositiveInt(env.CLOUD_AGENT_MAX_RETRIES, 2);

  let attempt = 0;
  while (true) {
    const now = Date.now();
    const elapsed = now - lastCloudSubmissionAt;
    if (lastCloudSubmissionAt > 0 && elapsed < cooldownMs) {
      await sleep(cooldownMs - elapsed);
    }
    lastCloudSubmissionAt = Date.now();

    try {
      return await run();
    } catch (error) {
      const classification = classifyCloudError(error);
      if (!classification.retryable || attempt >= maxRetries) throw error;

      const baseDelay = Math.min(1000 * (2 ** attempt), 8000);
      const jitter = Math.floor(Math.random() * 250);
      const waitMs = baseDelay + jitter;
      attempt++;
      console.warn(
        `${logPrefix} tentative ${attempt}/${maxRetries} après erreur retryable (${classification.reason}) — attente ${waitMs}ms.`,
      );
      await sleep(waitMs);
    }
  }
}
