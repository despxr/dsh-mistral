# dsh-mistral

Mistral for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) in **one plugin**: Responses API by default, prompt caching, per-model cost, subscription usage, and the platform tools worth offloading work to.

Replaces the `dsh-mistral-pro` + `dsh-mistral-native` pair with a single bundle that drops into any profile.

## Why this exists

Three problems, all fixed here:

1. **Reasoning models break on Chat Completions.** Mistral rejects a replayed `reasoning_content` with `422 extra_forbidden`, so GLM/DeepSeek lose their chain of thought between turns. The Responses API carries reasoning as a replayable item, and this bundle replays completed reasoning items on the next turn.
2. **Cost renders blank.** `dsh-chat-cost` maps the route `mistral` but not `mistral-pro`, and its models.dev snapshot predates `deepseek-v4-1-flash-1017`, `zai-glm-5-3` and `mistral-large-4`. This bundle ships its own price table.
3. **Prompt caching was invisible.** Mistral bills cached prefix tokens at a discount, but the old route reported no cache reads. This bundle surfaces `cacheReadTokens` and bills the cached portion at the cache rate.

On the Responses wire the adapter sends the dsh session id as `prompt_cache_key`, so cache routing stays stable across turns.

## Install

```bash
dsh plugin --profile <profile> add /path/to/dsh-mistral
```

Then set the provider in the profile's `cordis.patch.yml`:

```yaml
- id: mistral
  name: dsh-mistral
  config:
    api:
      type: responses        # default
    modelCatalog:
      defaultOnly: true      # only DeepSeek until you enable more
      enabled: []
    accounts:
      - name: mistral
        apiKeyEnv: MISTRAL_API_KEY
        enabled: true
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: mistral-pro
    model: deepseek-v4-1-flash-1017
```

> The route id is `mistral-pro`, not `mistral` — dsh already ships a built-in
> `mistral` provider and registering that name again throws
> `configurable provider "mistral" is already declared`. The user-facing
> display name is **Mistral**; only the route id carries the `-pro` suffix.

## Settings

| Field | Default | What it does |
|---|---|---|
| `api.type` | `responses` | Wire protocol. `chat` falls back to Chat Completions. |
| `modelCatalog.defaultOnly` | `true` | Offer only the default model family. |
| `modelCatalog.enabled` | `[]` | Model ids to expose on top of the default. |
| `usage.showCost` | `true` | Per-turn and session cost estimate. |
| `usage.showCredits` | `true` | Prepaid credit balance. |
| `usage.display` | `auto` | When the usage pill appears. |
| `advanced.failover` | `true` | Try the next account before any output. |

To use other Mistral models, either add them to `modelCatalog.enabled` or turn
`defaultOnly` off to expose the whole discovered catalog.

## Cost

`lib/prices.js` carries the table, USD per 1M tokens:

| Model | input | output | cache read |
|---|---|---|---|
| `deepseek-v4-1-flash-1017` | 0.30 | 1.20 | 0.007 |
| `zai-glm-5-3` | 1.40 | 4.40 | 0.14 |
| `zai-glm-5-3-flash` | 0.15 | 0.50 | 0.03 |
| `mistral-large-4` | 0.70 | 2.10 | 0.07 |
| `mistral-medium-latest` | 1.50 | 7.50 | 0.15 |
| `mistral-small-latest` | 0.15 | 0.60 | 0.015 |
| `codestral-latest` | 0.30 | 0.90 | 0.03 |

Unknown models fall back to a mid-tier estimate and report `priced: false`
rather than silently showing `$0.00`.

Cache reads bill at the discounted rate; the uncached remainder bills at the
input rate. Verified against a real turn:

```
input 6960, cached 6784, output 86
→ $0.0002 total, of which cache read $0.00005
   (the same 6784 tokens uncached would cost $0.0020)
```

## Vision

On the Responses wire, user attachments and tool-result images are sent as
`input_image` parts with a data URL, both in user content and in
`function_call_output`. The model list comes from the live
`GET /v1/models` `capabilities.vision` flag, so DeepSeek V4.1 Flash,
GLM-5.3-Flash, Mistral Large 4 and Magistral advertise image input while
GLM-5.3 stays text-only.

## Tools

Bundled from `dsh-mistral-native`:

| Tool | Endpoint | Use |
|---|---|---|
| `mistral_ocr` | `/v1/ocr` | PDF/image → markdown, instead of vision tokens |
| `mistral_embed` | `/v1/embeddings` | Code search / clustering |
| `mistral_fim` | `/v1/fim/completions` | Fast inline completion |
| `mistral_batch_submit` | `/v1/batch/jobs` | Async fan-out at 50% off |
| `mistral_batch_status` | `/v1/batch/jobs/{id}` | Poll a job |
| `mistral_usage` | `/v1/billing/budget` | Vibe Pro / API allowance |

## Verified

- Provider registers under `mistral-pro`; a live turn completes over `/responses`
- `mistral_usage` returns the real budget (`255 EUR` Vibe, `25.5 EUR` API)
- Prompt caching hits: `cacheReadTokens: 6784` of `6899` input on a warm turn
- Model filtering: `defaultOnly` → DeepSeek only; `enabled: [zai-glm-5-3]` → DeepSeek + GLM; `defaultOnly: false` → all
- Vision: user image, tool-result image, and multi-image turns complete over `/responses`
- Reasoning replay: a completed reasoning item is replayed and accepted on the next turn
- Cost math cross-checked against models.dev / Mistral's published rates

## Testing

`npm test` runs the pure-module tests with `node --test`:

- `test/responses.test.js` — Responses content parts, assistant replay, tool images
- `test/prices.test.js` — current price table and cache billing

The adapter itself needs a dsh profile's peer dependencies, so end-to-end checks
run inside a dsh profile.

## Gotchas found while building

- `PROVIDER_ID` must not be `mistral` — collides with the built-in provider.
- Responses content parts are `input_text` / `input_image` with a string URL;
  the Chat Completions `text` / `image_url` shape is rejected with
  `400 input.str: Input should be a valid string`.
- The tool output renderer must return dsh content blocks (`[{type:'text',...}]`),
  not an HTTP `Response`; sharing one `json()` helper for both fails with
  `output.render returned non-lossless JSON`.
- `config` inside a tool handler is the *provider* config object, so
  `config.baseURL` is not a string — read the endpoint explicitly.
- A plugin's `lib/adapter.js` cannot be imported standalone: ESM resolves
  `@deepseek-ai/dsh-llm` from the file's own location, so adapter tests need the
  profile's `node_modules`. `lib/responses.js` and `lib/prices.js` are pure and
  covered by `npm test`.

## License

MIT.
