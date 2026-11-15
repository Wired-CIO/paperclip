/**
 * OpenAI-compatible inference relay.
 *
 * Sandboxed agents (for example opencode_local on Daytona) cannot reach a private GPU
 * server directly. They reach Bullpen's public HTTPS origin instead. This relay
 * authenticates the caller with a dedicated relay key, then forwards the request to one
 * fixed upstream, replacing the caller's Authorization with the real upstream key. The
 * upstream key therefore never enters a sandbox.
 *
 * Disabled unless all three settings below are present. Everything is read per request so
 * tests can drive it; operators change it by editing the environment and restarting.
 *
 *   PAPERCLIP_LLM_RELAY_UPSTREAM_URL         e.g. http://192.168.12.108:8000/v1
 *   PAPERCLIP_LLM_RELAY_UPSTREAM_KEY         the upstream (vLLM) bearer
 *   PAPERCLIP_LLM_RELAY_CLIENT_KEY_SHA256S   comma-separated sha256 hex of accepted relay keys
 *
 * Optional:
 *   PAPERCLIP_LLM_RELAY_MODELS               comma-separated allowed model ids (default qwen3.8-27b)
 *   PAPERCLIP_LLM_RELAY_MAX_TOKENS           ceiling for max_tokens (default 32768)
 *   PAPERCLIP_LLM_RELAY_MAX_CONCURRENCY      in-flight requests per relay key (default 4)
 *   PAPERCLIP_LLM_RELAY_CONNECT_TIMEOUT_MS   time to first upstream response headers (default 20000)
 *   PAPERCLIP_LLM_RELAY_TOTAL_TIMEOUT_MS     ceiling for one request including streaming (default 900000)
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const LLM_RELAY_DEFAULT_MODEL = "qwen3.8-27b";
export const LLM_RELAY_DEFAULT_MAX_TOKENS = 32_768;
export const LLM_RELAY_DEFAULT_MAX_CONCURRENCY = 4;
export const LLM_RELAY_DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
export const LLM_RELAY_DEFAULT_TOTAL_TIMEOUT_MS = 900_000;

export interface LlmRelayConfig {
  upstreamUrl: URL;
  upstreamKey: string;
  clientKeyHashes: string[];
  models: string[];
  maxTokens: number;
  maxConcurrency: number;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Returns null when the relay is not fully configured (the route then answers 404). */
export function readLlmRelayConfig(env: NodeJS.ProcessEnv = process.env): LlmRelayConfig | null {
  const rawUrl = env.PAPERCLIP_LLM_RELAY_UPSTREAM_URL?.trim();
  const upstreamKey = env.PAPERCLIP_LLM_RELAY_UPSTREAM_KEY?.trim();
  const hashes = (env.PAPERCLIP_LLM_RELAY_CLIENT_KEY_SHA256S ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[0-9a-f]{64}$/.test(value));
  if (!rawUrl || !upstreamKey || hashes.length === 0) return null;
  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(upstreamUrl.protocol) || upstreamUrl.username || upstreamUrl.password) return null;
  // Normalise so paths can be appended safely.
  upstreamUrl.search = "";
  upstreamUrl.hash = "";
  upstreamUrl.pathname = upstreamUrl.pathname.replace(/\/+$/, "");
  const models = (env.PAPERCLIP_LLM_RELAY_MODELS ?? LLM_RELAY_DEFAULT_MODEL)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    upstreamUrl,
    upstreamKey,
    clientKeyHashes: hashes,
    models: models.length > 0 ? models : [LLM_RELAY_DEFAULT_MODEL],
    maxTokens: positiveInt(env.PAPERCLIP_LLM_RELAY_MAX_TOKENS, LLM_RELAY_DEFAULT_MAX_TOKENS),
    maxConcurrency: positiveInt(env.PAPERCLIP_LLM_RELAY_MAX_CONCURRENCY, LLM_RELAY_DEFAULT_MAX_CONCURRENCY),
    connectTimeoutMs: positiveInt(env.PAPERCLIP_LLM_RELAY_CONNECT_TIMEOUT_MS, LLM_RELAY_DEFAULT_CONNECT_TIMEOUT_MS),
    totalTimeoutMs: positiveInt(env.PAPERCLIP_LLM_RELAY_TOTAL_TIMEOUT_MS, LLM_RELAY_DEFAULT_TOTAL_TIMEOUT_MS),
  };
}

export interface RelayCaller {
  /** First 12 hex chars of the matching key hash: safe to log, identifies the key. */
  keyId: string;
  keyHash: string;
}

/** Constant-time check of an `Authorization: Bearer` header against the accepted key hashes. */
export function authenticateRelayCaller(
  authorization: string | undefined,
  config: Pick<LlmRelayConfig, "clientKeyHashes">,
): RelayCaller | null {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match) return null;
  const presented = Buffer.from(sha256Hex(match[1]!), "hex");
  let found: string | null = null;
  for (const hash of config.clientKeyHashes) {
    const candidate = Buffer.from(hash, "hex");
    // Compare every hash so timing does not reveal which one matched.
    if (candidate.length === presented.length && timingSafeEqual(candidate, presented) && !found) found = hash;
  }
  return found ? { keyId: found.slice(0, 12), keyHash: found } : null;
}

export type RelayValidation =
  | { ok: true; body: Record<string, unknown>; stream: boolean }
  | { ok: false; status: number; code: string; message: string };

/** Validates and clamps a chat-completions body. Returns a new body; never mutates the input. */
export function validateChatCompletionBody(
  input: unknown,
  config: Pick<LlmRelayConfig, "models" | "maxTokens">,
): RelayValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, status: 400, code: "invalid_body", message: "Request body must be a JSON object." };
  }
  const body = { ...(input as Record<string, unknown>) };
  const model = body.model;
  if (typeof model !== "string" || !config.models.includes(model)) {
    return {
      ok: false,
      status: 400,
      code: "model_not_allowed",
      message: `Model is not available on this relay. Allowed: ${config.models.join(", ")}.`,
    };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, status: 400, code: "invalid_body", message: "messages must be a non-empty array." };
  }
  for (const key of ["max_tokens", "max_completion_tokens"] as const) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return { ok: false, status: 400, code: "invalid_body", message: `${key} must be a positive number.` };
    }
    if (value > config.maxTokens) body[key] = config.maxTokens;
  }
  if (body.max_tokens === undefined && body.max_completion_tokens === undefined) {
    body.max_tokens = config.maxTokens;
  }
  return { ok: true, body, stream: body.stream === true };
}

/** Per-key in-flight limiter. In memory: one server process, so this is exact. */
export class RelayConcurrencyLimiter {
  private readonly inFlight = new Map<string, number>();

  tryAcquire(key: string, limit: number): (() => void) | null {
    const current = this.inFlight.get(key) ?? 0;
    if (current >= limit) return null;
    this.inFlight.set(key, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.inFlight.get(key) ?? 1) - 1;
      if (next <= 0) this.inFlight.delete(key);
      else this.inFlight.set(key, next);
    };
  }

  count(key: string): number {
    return this.inFlight.get(key) ?? 0;
  }
}

export type RelayPath = "chat-completions" | "models";

export function resolveUpstreamUrl(config: Pick<LlmRelayConfig, "upstreamUrl">, path: RelayPath): string {
  const base = config.upstreamUrl.toString().replace(/\/+$/, "");
  return `${base}/${path === "models" ? "models" : "chat/completions"}`;
}

export interface UpstreamResult {
  response: Response;
  /** Aborts the upstream request (client went away or total timeout fired). */
  abort: () => void;
  /** Clears the total-timeout timer once the body has been fully consumed. */
  done: () => void;
}

export class RelayUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Sends the request upstream. Fails fast (connect timeout) with a readable error rather than
 * hanging when the GPU server or the network path to it is down.
 */
export async function forwardToUpstream(input: {
  config: LlmRelayConfig;
  path: RelayPath;
  body?: Record<string, unknown>;
  clientSignal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<UpstreamResult> {
  const { config, path, body, clientSignal } = input;
  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const abort = () => controller.abort();
  clientSignal?.addEventListener("abort", abort, { once: true });
  const totalTimer = setTimeout(abort, config.totalTimeoutMs);
  totalTimer.unref?.();
  let connectTimedOut = false;
  const connectTimer = setTimeout(() => {
    connectTimedOut = true;
    controller.abort();
  }, config.connectTimeoutMs);
  connectTimer.unref?.();
  try {
    const response = await doFetch(resolveUpstreamUrl(config, path), {
      method: path === "models" ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${config.upstreamKey}`,
        Accept: body?.stream === true ? "text/event-stream" : "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(connectTimer);
    return {
      response,
      abort,
      done: () => {
        clearTimeout(totalTimer);
        clientSignal?.removeEventListener("abort", abort);
      },
    };
  } catch (error) {
    clearTimeout(connectTimer);
    clearTimeout(totalTimer);
    clientSignal?.removeEventListener("abort", abort);
    if (clientSignal?.aborted) throw new RelayUpstreamError(499, "client_closed", "Client closed the request.");
    if (connectTimedOut) {
      throw new RelayUpstreamError(
        504,
        "upstream_timeout",
        `The inference server did not answer within ${Math.round(config.connectTimeoutMs / 1000)} seconds. Check that the GPU server and the network path to it (Cloudflare WARP on the Bullpen host) are up.`,
      );
    }
    throw new RelayUpstreamError(
      502,
      "upstream_unreachable",
      "The inference server is unreachable. Check that the GPU server and the network path to it (Cloudflare WARP on the Bullpen host) are up.",
    );
  }
}
