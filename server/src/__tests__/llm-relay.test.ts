import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { llmRelayRoutes } from "../routes/llm-relay.js";
import {
  authenticateRelayCaller,
  readLlmRelayConfig,
  sha256Hex,
  validateChatCompletionBody,
} from "../services/llm-relay.js";

const CLIENT_KEY = "relay-client-key-for-tests";
const UPSTREAM_KEY = "upstream-secret-for-tests";

type UpstreamHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

describe("llm relay", () => {
  let upstream: Server;
  let upstreamPort: number;
  let relay: Server;
  let relayPort: number;
  let handler: UpstreamHandler;
  let seen: Array<{ method?: string; url?: string; authorization?: string; body: string }>;
  let env: NodeJS.ProcessEnv;

  const call = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${relayPort}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${CLIENT_KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });

  const chat = (body: Record<string, unknown>) =>
    call("/llm/wiredai/v1/chat/completions", { method: "POST", body: JSON.stringify(body) });

  async function startRelay() {
    const app = express();
    app.use(express.json());
    app.use(llmRelayRoutes({ env }));
    relay = createServer(app);
    relayPort = await listen(relay);
  }

  beforeEach(async () => {
    seen = [];
    handler = (_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: "ok" } }] }));
    };
    upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
        handler(req, res, body);
      });
    });
    upstreamPort = await listen(upstream);
    env = {
      PAPERCLIP_LLM_RELAY_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      PAPERCLIP_LLM_RELAY_UPSTREAM_KEY: UPSTREAM_KEY,
      PAPERCLIP_LLM_RELAY_CLIENT_KEY_SHA256S: sha256Hex(CLIENT_KEY),
      PAPERCLIP_LLM_RELAY_MAX_CONCURRENCY: "2",
      PAPERCLIP_LLM_RELAY_CONNECT_TIMEOUT_MS: "1500",
    };
    await startRelay();
  });

  afterEach(async () => {
    relay.closeAllConnections?.();
    upstream.closeAllConnections?.();
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  });

  it("answers 404 when the relay is not configured", async () => {
    // The router holds a reference to `env`, so clear it in place.
    for (const key of Object.keys(env)) delete env[key];
    const res = await call("/llm/wiredai/v1/models");
    expect(res.status).toBe(404);
  });

  it("rejects a missing or wrong relay key and never calls upstream", async () => {
    const wrong = await call("/llm/wiredai/v1/models", { headers: { Authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toBe("Bearer");
    const missing = await fetch(`http://127.0.0.1:${relayPort}/llm/wiredai/v1/models`);
    expect(missing.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("replaces the caller's Authorization with the upstream key", async () => {
    const res = await call("/llm/wiredai/v1/models");
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/v1/models");
    expect(seen[0]!.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(seen[0]!.authorization).not.toContain(CLIENT_KEY);
  });

  it("rejects a model that is not allowed", async () => {
    const res = await chat({ model: "something-else", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("model_not_allowed");
    expect(seen).toHaveLength(0);
  });

  it("clamps max_tokens and supplies a default", async () => {
    await chat({ model: "qwen3.8-27b", messages: [{ role: "user", content: "hi" }], max_tokens: 999_999 });
    await chat({ model: "qwen3.8-27b", messages: [{ role: "user", content: "hi" }] });
    expect(JSON.parse(seen[0]!.body).max_tokens).toBe(32_768);
    expect(JSON.parse(seen[1]!.body).max_tokens).toBe(32_768);
  });

  it("streams server-sent events through", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"b"}}]}\n\n');
        res.end("data: [DONE]\n\n");
      }, 50);
    };
    const res = await chat({ model: "qwen3.8-27b", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const text = await res.text();
    expect(text).toContain('"content":"a"');
    expect(text).toContain('"content":"b"');
    expect(text).toContain("[DONE]");
  });

  it("limits concurrent requests per relay key", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    handler = (_req, res) => {
      void gate.then(() => res.end(JSON.stringify({ ok: true })));
    };
    const body = { model: "qwen3.8-27b", messages: [{ role: "user", content: "hi" }] };
    const first = chat(body);
    const second = chat(body);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const third = await chat(body);
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("5");
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    // The slot is free again afterwards.
    expect((await chat(body)).status).toBe(200);
  });

  it("fails fast with a readable error when the upstream is unreachable", async () => {
    await new Promise((resolve) => upstream.close(resolve));
    const startedAt = Date.now();
    const res = await chat({ model: "qwen3.8-27b", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(502);
    const payload = await res.json();
    expect(payload.error.code).toBe("upstream_unreachable");
    expect(payload.error.message).toContain("WARP");
    expect(Date.now() - startedAt).toBeLessThan(3000);
    // Reopen so afterEach can close cleanly.
    upstream = createServer();
    await listen(upstream);
  });

  it("times out with a readable error when the upstream never answers", async () => {
    handler = () => undefined; // never respond
    const startedAt = Date.now();
    const res = await chat({ model: "qwen3.8-27b", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(504);
    expect((await res.json()).error.code).toBe("upstream_timeout");
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });

  it("reports a rejected upstream credential as a relay problem, not the caller's", async () => {
    handler = (_req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "Unauthorized" }));
    };
    const res = await chat({ model: "qwen3.8-27b", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("upstream_auth_failed");
  });

  it("passes through upstream validation errors", async () => {
    handler = (_req, res) => {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: "context too long" } }));
    };
    const res = await chat({ model: "qwen3.8-27b", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("context too long");
  });

  it("health reports served and missing models", async () => {
    handler = (_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "qwen3.8-27b" }] }));
    };
    const ok = await call("/llm/wiredai/health");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, servedModels: ["qwen3.8-27b"], modelsMissing: [] });

    handler = (_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "other" }] }));
    };
    const missing = await call("/llm/wiredai/health");
    expect((await missing.json()).modelsMissing).toEqual(["qwen3.8-27b"]);
  });

  it("health requires the relay key", async () => {
    const res = await fetch(`http://127.0.0.1:${relayPort}/llm/wiredai/health`);
    expect(res.status).toBe(401);
  });
});

describe("llm relay helpers", () => {
  it("needs url, upstream key and at least one valid key hash", () => {
    const valid = {
      PAPERCLIP_LLM_RELAY_UPSTREAM_URL: "http://10.0.0.1:8000/v1/",
      PAPERCLIP_LLM_RELAY_UPSTREAM_KEY: "k",
      PAPERCLIP_LLM_RELAY_CLIENT_KEY_SHA256S: sha256Hex("a"),
    };
    expect(readLlmRelayConfig(valid)?.upstreamUrl.toString()).toBe("http://10.0.0.1:8000/v1");
    expect(readLlmRelayConfig({ ...valid, PAPERCLIP_LLM_RELAY_UPSTREAM_KEY: "" })).toBeNull();
    expect(readLlmRelayConfig({ ...valid, PAPERCLIP_LLM_RELAY_CLIENT_KEY_SHA256S: "not-a-hash" })).toBeNull();
    expect(readLlmRelayConfig({ ...valid, PAPERCLIP_LLM_RELAY_UPSTREAM_URL: "http://u:p@h/v1" })).toBeNull();
    expect(readLlmRelayConfig({ ...valid, PAPERCLIP_LLM_RELAY_UPSTREAM_URL: "ftp://h/v1" })).toBeNull();
    expect(readLlmRelayConfig({})).toBeNull();
  });

  it("accepts any of several key hashes and rejects others", () => {
    const config = { clientKeyHashes: [sha256Hex("one"), sha256Hex("two")] };
    expect(authenticateRelayCaller("Bearer two", config)?.keyId).toBe(sha256Hex("two").slice(0, 12));
    expect(authenticateRelayCaller("Bearer three", config)).toBeNull();
    expect(authenticateRelayCaller("Basic two", config)).toBeNull();
    expect(authenticateRelayCaller(undefined, config)).toBeNull();
  });

  it("validates the chat body without mutating the input", () => {
    const input = { model: "m", messages: [{ role: "user", content: "x" }], max_tokens: 5 };
    const config = { models: ["m"], maxTokens: 10 };
    const result = validateChatCompletionBody(input, config);
    expect(result.ok).toBe(true);
    expect(validateChatCompletionBody({ ...input, max_tokens: -1 }, config).ok).toBe(false);
    expect(validateChatCompletionBody({ ...input, messages: [] }, config).ok).toBe(false);
    expect(validateChatCompletionBody(null, config).ok).toBe(false);
    expect(input.max_tokens).toBe(5);
  });
});
