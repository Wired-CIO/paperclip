# Inference relay (`/llm/wiredai`)

Lets agents that run in Daytona sandboxes use a private GPU server for inference.

A sandbox cannot reach a private network, so it calls Bullpen's public HTTPS origin. Bullpen
authenticates the caller with a dedicated **relay key**, then forwards to one fixed upstream with
the real upstream key. The upstream key never enters a sandbox.

```
sandbox agent (opencode_local) --HTTPS--> bullpen /llm/wiredai/v1/* --WARP--> vLLM 192.168.12.108:8000
        relay key                          swaps in the upstream key
```

The relay is **off** (404) unless all three required variables are set.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `PAPERCLIP_LLM_RELAY_UPSTREAM_URL` | yes | OpenAI-compatible base, e.g. `http://192.168.12.108:8000/v1` |
| `PAPERCLIP_LLM_RELAY_UPSTREAM_KEY` | yes | Bearer the upstream expects (the vLLM key) |
| `PAPERCLIP_LLM_RELAY_CLIENT_KEY_SHA256S` | yes | Comma-separated SHA-256 hex of accepted relay keys |
| `PAPERCLIP_LLM_RELAY_MODELS` | no | Allowed model ids, default `qwen3.8-27b` |
| `PAPERCLIP_LLM_RELAY_MAX_TOKENS` | no | Ceiling for `max_tokens`, default 32768 |
| `PAPERCLIP_LLM_RELAY_MAX_CONCURRENCY` | no | In-flight requests per relay key, default 4 |
| `PAPERCLIP_LLM_RELAY_CONNECT_TIMEOUT_MS` | no | Wait for upstream headers, default 20000 |
| `PAPERCLIP_LLM_RELAY_TOTAL_TIMEOUT_MS` | no | Ceiling for one request including streaming, default 900000 |

Only hashes of relay keys are stored in the server environment. Generate a key and its hash:

```sh
key=$(openssl rand -hex 32); printf '%s\n' "$key"; printf '%s' "$key" | sha256sum
```

Keep the key for the AI connection below. Put only the hash in `PAPERCLIP_LLM_RELAY_CLIENT_KEY_SHA256S`.
Rotate by adding the new hash, switching the connection, then removing the old hash.

The context window is enforced by the upstream (the served model reports 131072). The relay
clamps `max_tokens` only.

## Endpoints

All require `Authorization: Bearer <relay key>`.

- `GET  /llm/wiredai/v1/models`
- `POST /llm/wiredai/v1/chat/completions` (streaming supported)
- `GET  /llm/wiredai/health`: probes upstream and reports served and missing models

Errors are readable and fast: `upstream_unreachable` (502) and `upstream_timeout` (504) name the
GPU server and the WARP path; `upstream_auth_failed` (502) means the relay's own upstream key was
rejected; `model_not_allowed` (400); `too_many_requests` (429 with `Retry-After`).

## Using it from the UI

1. In the company's AI connections, add a **Chat Completions API** connection:
   base URL `https://bullpen.wiredcio.com/llm/wiredai/v1`, authentication Bearer, the relay key
   as the secret, model `qwen3.8-27b`.
2. Create an agent with the **OpenCode** harness on a Daytona sandbox environment and attach that
   connection. (`hermes_local` runs on the Paperclip host only and has no sandbox support;
   `hermes_gateway` talks to a remote Hermes server and does not carry Bullpen identity or tools.)

## Deploying

The production compose file (`/opt/paperclip/docker/docker-compose.managed.yml`) lists environment
variables explicitly, so add the new ones under `server.environment`:

```yaml
      PAPERCLIP_LLM_RELAY_UPSTREAM_URL: ${PAPERCLIP_LLM_RELAY_UPSTREAM_URL:-}
      PAPERCLIP_LLM_RELAY_UPSTREAM_KEY: ${PAPERCLIP_LLM_RELAY_UPSTREAM_KEY:-}
      PAPERCLIP_LLM_RELAY_CLIENT_KEY_SHA256S: ${PAPERCLIP_LLM_RELAY_CLIENT_KEY_SHA256S:-}
```

and set the values in `/opt/paperclip/.env.prod` (mode 600). The Bullpen host must reach the
upstream: Cloudflare WARP in Traffic-only mode with a split tunnel including the GPU server.

## Security notes

- The upstream host is fixed in configuration. Callers cannot supply URLs; only the two paths above
  are served.
- Prompts and completions are never logged. A request log line carries the key id (first 12 hex of
  the hash), path, model, status and duration.
- The relay key is a shared secret for every agent using the connection. It grants inference only,
  and is limited by the model allowlist, `max_tokens` ceiling and per-key concurrency limit.
- A reverse proxy in front of Bullpen must not buffer `text/event-stream` responses. The relay sets
  `X-Accel-Buffering: no`.
