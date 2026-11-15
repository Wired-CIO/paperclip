# wiredai inference relay for Daytona-run agents

> **Correction (2026-11-15, found while building):** the sections below assumed `hermes_local`
> could run in a Daytona sandbox. It cannot: its adapter has no remote-execution support (its
> connection test returns `hermes_remote_probe_unsupported`), and only the claude, codex, cursor,
> gemini, grok, kimi, opencode and pi adapters run on sandbox targets. The deployed branch
> already has **AI connections** ("Chat Completions API" gateway kind, HTTPS base URL, model
> list, `opencode_local` and `hermes_local` compatible). So the build is **only the relay**
> (`server/src/routes/llm-relay.ts`, `server/src/services/llm-relay.ts`, see `doc/LLM-RELAY.md`).
> Agents use the **OpenCode** harness on Daytona with a Chat Completions connection pointing at
> the relay. No Hermes adapter or provider-list change is needed. The Hermes 0.19.0 findings
> below remain true and apply to `hermes_local` on the Paperclip host. Context window: the
> served model reports 131072, which is the value to use.


Status: proposed (not implemented). Date: 2026-11-15.

## Goal

An operator creating or editing an agent in the Bullpen UI picks `hermes_local` on a
Daytona sandbox, picks the local Qwen model (`qwen3.8-27b`), and it works: the agent
runs in its own sandbox, and the GPU server (`wiredai`, vLLM) only does inference.
No per-agent server work, no key inside the sandbox.

## What we verified (2026-11-14/15)

- GPU endpoints: vLLM `http://192.168.12.108:8000/v1` (401 without key), Hermes API
  server `https://192.168.12.108:8643` (Caddy internal CA; plain 8642 is loopback only).
- The Bullpen VM reaches `192.168.12.108/32` through Cloudflare WARP (Traffic-only
  mode, dedicated device profile). Azure DNS and the DB are unaffected. WARP is enabled
  at boot and survived a reboot test.
- Bullpen's Node trusts the Caddy CA: `NODE_EXTRA_CA_CERTS=/etc/ssl/paperclip/hermes-ca.pem`
  in the VM-local `docker/docker-compose.managed.yml`, bind-mounted from
  `/etc/paperclip/certs/hermes-ca.pem`.
- `hermes_gateway` works but only chat-style: it sends a text prompt to a remote Hermes
  host. No run token, MCP gateway, managed skills or connection grants reach it, and
  commands run on the GPU host as a shared user. Not suitable for client work.
- The Daytona runner image already contains `hermes-agent==0.19.0`
  (`docker/daytona-runner/Dockerfile`).
- Daytona sandboxes cannot reach `192.168.12.108`. Only the Bullpen VM can.

## Design

```
Daytona sandbox (hermes_local, ~/.hermes/config.yaml: provider custom)
   -> https://bullpen.wiredcio.com/llm/wiredai/v1/*   (public origin, CH-6)
      or the sandbox callback bridge (filtered egress, CH-7 style)
   -> Bullpen server relay route (authenticates the agent, injects the vLLM key)
   -> http://192.168.12.108:8000/v1/*  via WARP
```

### 1. Relay route (server)

- New route group `/llm/wiredai/v1/*` that proxies OpenAI-compatible calls
  (`/chat/completions`, `/models`, `/embeddings` not needed initially) to the configured
  upstream. Streaming (SSE) passthrough is required.
- Auth: normal Paperclip actor auth. Agent run token / agent API key only. Board users
  may call it for testing. Reject everything else. Enforce company scope: the agent's
  company must have the `wiredai` provider enabled.
- The vLLM key is read server-side from a company secret or instance env. It is never
  returned, logged, or forwarded to the caller. Strip the caller's `Authorization`
  before the upstream call and set the upstream key.
- Request limits: cap `max_tokens`, enforce the 65,536-token context ceiling, a body
  size cap, per-agent concurrency limit, upstream timeout (fail fast with a readable
  error, not a hang).
- Activity log entry per run (not per request) with token usage taken from the
  upstream `usage` field, tied to the run id. Costs: record as zero-cost with usage
  counted, so budgets still see volume.

Files (to confirm): `server/src/routes/` (new `llm-relay.ts`), route registration in
the server app, `server/src/services/` (relay service + upstream config),
`packages/shared` (provider constants and config shape).

### 2. Sandbox reachability

- Default path: the sandbox calls the public HTTPS origin. This needs egress 443 to
  `bullpen.wiredcio.com`. Daytona's org tier may filter egress (see
  `daytona-org-tier-limits`). Verify before building anything else.
- If egress is filtered, add the relay paths to
  `DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST` in
  `packages/adapter-utils/src/sandbox-callback-bridge.ts`. Unlike the CH-7 MCP routes,
  no Authorization carve-out is needed: the bridge substitutes the host token, which is
  the correct identity for the relay. Streaming through the exec-channel bridge is an
  open risk (see below).

### 3. Hermes provider and model selection

- `hermes_local` shells out to `hermes chat` and reads `~/.hermes/config.yaml`.
  `resolveProvider` already returns `auto` when the config model matches and the
  provider is unsupported (such as `custom`), deferring to Hermes. So no change to
  `VALID_PROVIDERS` is needed for runtime.
- Seed the sandbox with a config that points Hermes at the relay:
  `model.default: qwen3.8-27b`, `provider: custom`, `base_url: <relay>/v1`,
  `api_key` from an env var the harness sets to the run token. The config is written
  by the adapter at run start (same place `reconcileHermesPaperclipSkills` runs), not
  baked into the image, and contains no long-lived secret.
- UI: add `qwen3.8-27b` to the Hermes model list so the agent editor offers it. The
  agent's own model setting must equal the config default, or `resolveProvider` will
  not defer. Check how `adapter-models` builds the list.

Files (to confirm): `packages/adapters/hermes/src/server/execute.ts`,
`detect-model.ts`, `skills.ts`, `ui/build-config.ts`, `server/src/__tests__/adapter-models.test.ts`.

### 4. Health and errors

- `GET /llm/wiredai/health` (board-visible) probes upstream `/models` and reports
  WARP, DNS, TLS and auth separately.
- A failing probe shows in the agent's Harness/Runtime test and in the run error. A
  down GPU must fail within a few seconds with a readable message.

### 5. Isolation

- One sandbox per agent. No shared Hermes user or home. Client-facing agents keep
  their sandbox terminal backend. The relay holds the only copy of the vLLM key.
- The relay must not become a general internal proxy: fixed upstream host and port, an
  allowlist of paths and methods, no caller-supplied URLs.
- Rate-limit per agent and per company so one agent cannot starve the GPU.

## Spike results (2026-11-15)

- **Hermes 0.19.0 supports what the design needs.** Installed in a throwaway
  `python:3.12-slim` container (removed afterwards). `hermes chat --provider` accepts
  "a user-defined name from `providers:` in config.yaml", and the package carries
  `custom_providers` support, a `model.base_url` direct OpenAI-compatible endpoint, and
  `model.api_key` (falls back to `OPENAI_API_KEY`). So a seeded `config.yaml` pointing at
  the relay is viable, with no Hermes bump needed for the endpoint wiring.
- **Egress to `bullpen.wiredcio.com` from Daytona: inferred yes, not proven.** The
  environment "Daytona Sandbox Template" sets no `paperclipReachability`, so it uses
  the CH-6 default (public HTTPS origin), `PAPERCLIP_API_URL` is
  `https://bullpen.wiredcio.com`, and 303 runs succeeded in the last two days. No run
  event names the path explicitly. Prove it with a one-off `curl` from a sandbox.
- **Qwen tool calling works through Hermes 0.19.0 (proven, key from Key Vault).**
  vLLM returns a well-formed `tool_calls` entry with reasoning tokens
  (`finish_reason: tool_calls`). Hermes 0.19.0 in a throwaway container, with a seeded
  `config.yaml` (`provider: custom`, `base_url`, `model.default: qwen3.8-27b`) and the
  terminal toolset, ran `df -h /` and answered with the real figure.
- **Gotcha: the `OPENAI_API_KEY` fallback is not honoured for `provider: custom`.**
  The first attempt returned `HTTP 401`. The key must be written to `model.api_key` in
  the config. For the relay, write the run token there (or an env var the config
  references) at run start, never a long-lived secret.
- **Gotcha: the served model reports `max_model_len` 131072**, not the 65,536 we were
  told. Decide which to enforce in the relay and in Hermes's context setting.
- **Behaviour note:** the model repeats its reasoning a few times before acting.
  Acceptable, but watch token usage and `--max-turns`.
- **Still unproven:** streaming through the relay from a real sandbox. Sandbox launches
  go through the `docker-server-1` SDK path and are Russell's Run button (classifier).

## Rollout

1. Spike (no deploy): from a throwaway Daytona sandbox, check egress to
   `bullpen.wiredcio.com:443`, and run `hermes` 0.19.0 with a custom provider against
   a temporary tunnel to confirm it speaks to vLLM (tool calls, reasoning parser).
2. Implement relay + tests behind an instance setting, default off.
3. Implement adapter config seeding + model list + health probe.
4. PR to `master` of the fork, then merge to `wiredcio/deploy` (ships to production,
   no gate: needs a rollback note and a quiet window).
5. Verify end to end: UI-created agent on Daytona, a task with a tool call, reboot,
   cleanup.

## Open questions and risks

- Does the Daytona tier allow egress to `bullpen.wiredcio.com`? If not, streaming
  over the bridge needs proof or a non-streaming mode.
- Does Hermes 0.19.0 handle Qwen's tool-call and reasoning format? The GPU Hermes is
  0.23.1. We may need to bump the runner image.
- vLLM concurrency and the 65,536 context cap under multiple agents: a queue or a
  limit per company may be needed.
- Where the vLLM key lives long term (company secret vs instance env) and who
  rotates it.
- Billing and budget semantics for a zero-cost provider.
- Upstream sync: keep the relay in new files and the allowlist change to one line, so
  upstream merges stay easy.

## Cleanup owed from the 2026-11-15 session

- Delete the test agent `qwen-hermes-test` and task `WIR-2367` in Bullpen.
- The VM compose edit (CA mount) stays; backups sit beside the compose file.
- Decide whether the `hermes_gateway` route stays for chat-only agents.
