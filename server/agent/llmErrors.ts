import { ApiError } from '@google/genai';
import type { LlmFailureKind } from '../../src/types/agent.ts';

/** An LLM step that could not use Gemini, with the reason classified for the UI and telemetry. */
export class LlmUnavailableError extends Error {
  readonly kind: LlmFailureKind;

  constructor(kind: LlmFailureKind, message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
    this.kind = kind;
  }
}

const LABEL: Record<LlmFailureKind, string> = {
  quota: 'Gemini quota exhausted (HTTP 429 RESOURCE_EXHAUSTED)',
  rate_guard: 'Local Free Tier guard reached (15 RPM / 1,500 RPD); Gemini was not called',
  timeout: 'Gemini did not answer within the time limit',
  budget: 'Run time budget exhausted before Gemini could be called',
  not_configured: 'GEMINI_API_KEY is not configured',
  invalid_output: 'Gemini answered, but the output failed schema validation',
  skipped: 'LLM step skipped',
  error: 'Gemini request failed',
};

export function failureLabel(kind: LlmFailureKind): string {
  return LABEL[kind];
}

/** Maps any error thrown by an LLM step to a failure kind and a user-facing message. */
export function classifyLlmError(error: unknown): { kind: LlmFailureKind; message: string } {
  if (error instanceof LlmUnavailableError) return { kind: error.kind, message: error.message };
  if (error instanceof ApiError) {
    if (error.status === 429) return { kind: 'quota', message: `${LABEL.quota}: ${firstLine(error.message)}` };
    return { kind: 'error', message: `${LABEL.error} (HTTP ${error.status}): ${firstLine(error.message)}` };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/RESOURCE_EXHAUSTED|\b429\b|quota/i.test(message)) return { kind: 'quota', message: `${LABEL.quota}: ${firstLine(message)}` };
  if (/timed out/i.test(message)) return { kind: 'timeout', message: `${LABEL.timeout}: ${message}` };
  if (/schema validation failed|Unexpected token|JSON/i.test(message)) return { kind: 'invalid_output', message: `${LABEL.invalid_output}: ${firstLine(message)}` };
  return { kind: 'error', message: `${LABEL.error}: ${firstLine(message)}` };
}

/**
 * After Gemini answers HTTP 429, further calls are skipped for a cool-down period instead of being sent: retrying an
 * exhausted quota only burns requests and time. 429s are never retried inside a call either (only 500/503 are).
 */
export const QUOTA_COOLDOWN_MS = 60_000;

export class QuotaGuard {
  private exhaustedAt: number | null = null;

  markExhausted(now = Date.now()): void {
    this.exhaustedAt = now;
  }

  /** Remaining cool-down in ms, or 0 when calls may be attempted. */
  cooldownRemaining(now = Date.now()): number {
    if (this.exhaustedAt === null) return 0;
    return Math.max(0, this.exhaustedAt + QUOTA_COOLDOWN_MS - now);
  }

  /** Throws a classified 'quota' error while the cool-down is active. */
  assertAvailable(now = Date.now()): void {
    const left = this.cooldownRemaining(now);
    if (left > 0) {
      throw new LlmUnavailableError('quota', `${LABEL.quota}: skipped — the quota was already exhausted ${Math.round((QUOTA_COOLDOWN_MS - left) / 1000)} s ago; no new request was sent`);
    }
  }
}

export function isQuotaError(error: unknown): boolean {
  return classifyLlmError(error).kind === 'quota';
}

function firstLine(text: string): string {
  // API errors embed a JSON body; keep the readable message only.
  const json = /"message"\s*:\s*"([^"]{1,200})/.exec(text);
  return (json?.[1] ?? text.split('\n')[0]).slice(0, 200);
}
