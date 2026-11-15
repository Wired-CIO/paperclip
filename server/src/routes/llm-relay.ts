import { Router, type Request, type Response } from "express";
import { Readable } from "node:stream";
import { logger } from "../middleware/logger.js";
import {
  RelayConcurrencyLimiter,
  RelayUpstreamError,
  authenticateRelayCaller,
  forwardToUpstream,
  readLlmRelayConfig,
  validateChatCompletionBody,
  type LlmRelayConfig,
  type RelayPath,
} from "../services/llm-relay.js";

const RELAY_PREFIX = "/llm/wiredai";
const RESPONSE_HEADERS_TO_COPY = ["content-type", "cache-control", "retry-after"];

function relayError(res: Response, status: number, code: string, message: string) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({ error: { message, type: "relay_error", code } });
}

/**
 * Mounted before actor middleware: callers authenticate with a dedicated relay key, not a
 * Paperclip board or agent token. See services/llm-relay.ts for configuration.
 */
export function llmRelayRoutes(options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}) {
  const router = Router();
  const limiter = new RelayConcurrencyLimiter();

  const authorize = (req: Request, res: Response): { config: LlmRelayConfig; keyId: string; keyHash: string } | null => {
    const config = readLlmRelayConfig(options.env);
    if (!config) {
      relayError(res, 404, "not_found", "Not found.");
      return null;
    }
    const caller = authenticateRelayCaller(req.headers.authorization, config);
    if (!caller) {
      res.setHeader("WWW-Authenticate", "Bearer");
      relayError(res, 401, "unauthorized", "Invalid relay key.");
      return null;
    }
    return { config, keyId: caller.keyId, keyHash: caller.keyHash };
  };

  const clientAbortSignal = (res: Response) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    return controller.signal;
  };

  const sendUpstream = async (input: {
    req: Request;
    res: Response;
    config: LlmRelayConfig;
    keyId: string;
    path: RelayPath;
    body?: Record<string, unknown>;
    model?: string;
    release?: () => void;
  }) => {
    const { res, config, keyId, path, body, model, release } = input;
    const startedAt = Date.now();
    let status = 0;
    try {
      const upstream = await forwardToUpstream({
        config,
        path,
        body,
        clientSignal: clientAbortSignal(res),
        fetchImpl: options.fetchImpl,
      });
      status = upstream.response.status;
      if (status === 401 || status === 403) {
        // The relay's own upstream credential was rejected: an operator problem, not the caller's.
        upstream.abort();
        upstream.done();
        status = 502;
        relayError(res, 502, "upstream_auth_failed", "The relay's credential for the inference server was rejected. Ask an administrator to check the relay upstream key.");
        return;
      }
      for (const header of RESPONSE_HEADERS_TO_COPY) {
        const value = upstream.response.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      res.setHeader("X-Accel-Buffering", "no");
      res.status(status);
      res.flushHeaders();
      if (!upstream.response.body) {
        upstream.done();
        res.end();
        return;
      }
      const stream = Readable.fromWeb(upstream.response.body as Parameters<typeof Readable.fromWeb>[0]);
      stream.on("error", () => {
        upstream.done();
        if (!res.writableEnded) res.destroy();
      });
      stream.on("end", () => upstream.done());
      res.on("close", () => {
        upstream.abort();
        upstream.done();
      });
      stream.pipe(res);
      await new Promise<void>((resolve) => res.on("close", () => resolve()));
    } catch (error) {
      if (error instanceof RelayUpstreamError) {
        status = error.status;
        if (!res.headersSent) relayError(res, error.status === 499 ? 499 : error.status, error.code, error.message);
        else res.destroy();
      } else {
        status = 500;
        logger.error({ err: error, keyId }, "llm relay failed unexpectedly");
        if (!res.headersSent) relayError(res, 500, "relay_error", "The relay failed unexpectedly.");
        else res.destroy();
      }
    } finally {
      release?.();
      // No prompts or completions are logged, only metadata.
      logger.info({ keyId, path, model: model ?? null, status, durationMs: Date.now() - startedAt }, "llm relay request");
    }
  };

  router.get(`${RELAY_PREFIX}/v1/models`, async (req, res) => {
    const auth = authorize(req, res);
    if (!auth) return;
    await sendUpstream({ req, res, config: auth.config, keyId: auth.keyId, path: "models" });
  });

  router.post(`${RELAY_PREFIX}/v1/chat/completions`, async (req, res) => {
    const auth = authorize(req, res);
    if (!auth) return;
    const validated = validateChatCompletionBody(req.body, auth.config);
    if (!validated.ok) {
      relayError(res, validated.status, validated.code, validated.message);
      return;
    }
    const release = limiter.tryAcquire(auth.keyHash, auth.config.maxConcurrency);
    if (!release) {
      res.setHeader("Retry-After", "5");
      relayError(res, 429, "too_many_requests", `Too many concurrent requests for this relay key (limit ${auth.config.maxConcurrency}). Retry shortly.`);
      return;
    }
    await sendUpstream({
      req,
      res,
      config: auth.config,
      keyId: auth.keyId,
      path: "chat-completions",
      body: validated.body,
      model: String(validated.body.model),
      release,
    });
  });

  // Operator health check: authenticated, reports which layer failed rather than just "down".
  router.get(`${RELAY_PREFIX}/health`, async (req, res) => {
    const auth = authorize(req, res);
    if (!auth) return;
    const startedAt = Date.now();
    try {
      const upstream = await forwardToUpstream({
        config: { ...auth.config, connectTimeoutMs: Math.min(auth.config.connectTimeoutMs, 5_000), totalTimeoutMs: 8_000 },
        path: "models",
        fetchImpl: options.fetchImpl,
      });
      const ok = upstream.response.ok;
      let served: string[] = [];
      if (ok) {
        const payload = (await upstream.response.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
        served = (payload?.data ?? []).map((entry) => String(entry.id ?? "")).filter(Boolean);
      } else {
        await upstream.response.body?.cancel().catch(() => undefined);
      }
      upstream.done();
      res.setHeader("Cache-Control", "no-store");
      res.status(ok ? 200 : 502).json({
        ok,
        upstreamStatus: upstream.response.status,
        latencyMs: Date.now() - startedAt,
        allowedModels: auth.config.models,
        servedModels: served,
        modelsMissing: auth.config.models.filter((model) => !served.includes(model)),
        error: ok ? null : upstream.response.status === 401 || upstream.response.status === 403 ? "upstream_auth_failed" : "upstream_error",
      });
    } catch (error) {
      const known = error instanceof RelayUpstreamError ? error : null;
      res.setHeader("Cache-Control", "no-store");
      res.status(known?.status === 499 ? 499 : 502).json({
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: known?.code ?? "relay_error",
        message: known?.message ?? "The relay failed unexpectedly.",
      });
    }
  });

  return router;
}
