/**
 * dsh-mistral — a Mistral subscription provider for DeepSeek Harness.
 *
 * The Host half registers one `llm` route backed by Mistral's OpenAI-compatible
 * chat completions API, keeps a live model catalog, resolves keys through the
 * credential seam, fails over between accounts before any output is produced,
 * and serves the usage/settings data the browser half reads.
 */
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { Config, DISPLAY_NAME, PROVIDER_ID, readConfig } from './lib/config.js'
import { resolveCatalog, isVisible } from './lib/catalog.js'
import { AccountPool, resolveAccountKey } from './lib/accounts.js'
import { MistralProAdapter } from './lib/adapter.js'
import { createUsageService, summarizeCost } from './lib/usage.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export { Config }
export const name = 'dsh-mistral'
export const inject = ['llm', 'tools']

const DEFAULT_BASE = 'https://api.mistral.ai/v1'
const ROUTE_PREFIX = '/plugins/dsh-mistral'
const LOG_TAG = '[dsh-mistral]'

/** JSON response helper shared by every route. */
/** Tool output renderer: dsh content blocks, losslessly JSON-serialisable. */
function toolJson(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** HTTP response helper shared by the browser routes. */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}


/**
 * Read a secret from dsh's own credential store (~/.dsh/.credentials.yaml).
 *
 * The TUI and web profiles keep keys there rather than exporting them, so a
 * plugin that reads only `process.env` works from a shell but fails when the
 * host launches it. `refs.<NAME>` is a plain string or `{ value }`.
 */
function credentialRef(name) {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
    const refs = /^refs:[ \t]*\n([\s\S]*?)(?=^\S|$)/m.exec(text)
    if (refs === null) return undefined
    const line = new RegExp(`^[ \\t]+${name}:[ \\t]*(.+)$`, 'm').exec(refs[1])
    if (line === null) return undefined
    const raw = line[1].trim().replace(/^['"]|['"]$/g, '')
    // A nested object form keeps the value on a deeper line.
    const nested = /^value:\s*(.+)$/.exec(raw)
    return (nested?.[1] ?? raw).trim() || undefined
  } catch {
    return undefined
  }
}

/** Resolve the API key from the environment, then the dsh credential store. */
function apiKeyOf(config) {
  const envName = config?.apiKeyEnv ?? 'MISTRAL_API_KEY'
  const fromEnv = process.env[envName]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const stored = credentialRef(envName)
  if (stored !== undefined && stored !== '') return stored
  throw new Error(`no Mistral API key: set ${envName} or add it to ~/.dsh/.credentials.yaml refs`)
}

async function callMistral(config, path, body, { method = 'POST', signal } = {}) {
  // `config` here is the provider config object, so the endpoint comes from its
  // own baseURL field; fall back to the public API.
  const raw = typeof config?.baseURL === 'string' && config.baseURL !== '' ? config.baseURL : DEFAULT_BASE
  const base = raw.replace(/\/+$/, '')
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKeyOf(config)}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { raw: text }
  }
  if (!response.ok) {
    const detail = typeof parsed === 'object' ? JSON.stringify(parsed).slice(0, 500) : String(parsed).slice(0, 500)
    throw new Error(`Mistral ${path} failed (${response.status}): ${detail}`)
  }
  return parsed
}

/**
 * Register the provider, catalog, usage service and browser routes.
 * @param ctx - plugin context.
 * @param config - live plugin configuration.
 */
export function apply(ctx, config) {
  const read = () => readConfig(config)
  const pool = new AccountPool()
  const discovered = { ids: [], models: [] }
  const adapter = new MistralProAdapter({ ctx, readConfig: read, pool, discovered })
  const usage = createUsageService({ ctx, readConfig: read })

  const settingsNs = ctx.fiber?.entry?.options?.id ?? name

  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER_ID,
      displayName: DISPLAY_NAME,
      settingsNs,
      settingsPath: [],
    },
  ])

  ctx.llm.registerAdapter([PROVIDER_ID], adapter)

  ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
    const baseURL = typeof request.baseURL === 'string' && request.baseURL !== '' ? request.baseURL : read().baseURL
    const apiKey = typeof request.apiKey === 'string' ? request.apiKey : undefined
    if (apiKey === undefined) return []
    const response = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
      headers: { ...attributionHeaders(), authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return []
    const payload = await response.json()
    const entries = Array.isArray(payload?.data) ? payload.data : []
    return entries
      .filter((entry) => typeof entry?.id === 'string')
      .map((entry) => ({
        id: entry.id,
        name: typeof entry.name === 'string' ? entry.name : entry.id,
      }))
  })

  // The plugin ships its own settings page; the generic schema form would show
  // raw account arrays instead of the account cards.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  /** Refresh the live catalog from the first usable account. */
  const refreshCatalog = async () => {
    const current = read()
    const account = pool.attemptOrder(current)[0] ?? current.accounts[0]
    if (account === undefined) return
    let apiKey
    try {
      apiKey = await resolveAccountKey(ctx, account)
    } catch {
      return
    }
    try {
      const response = await fetch(`${account.baseURL}/models`, {
        headers: { ...attributionHeaders(), authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) return
      const payload = await response.json()
      const models = (Array.isArray(payload?.data) ? payload.data : [])
        .filter((entry) => entry?.capabilities?.completion_chat === true)
        .map((entry) => ({
          id: entry.id,
          name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id,
          aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
          contextWindow: Number.isFinite(entry.max_context_length) ? entry.max_context_length : undefined,
          vision: entry.capabilities?.vision === true,
          reasoning: entry.capabilities?.reasoning === true,
        }))
        .filter((entry) => typeof entry.id === 'string' && entry.id !== '')
      if (models.length === 0) return
      const changed = JSON.stringify(models) !== JSON.stringify(discovered.models)
      if (changed) {
        discovered.models = models
        discovered.ids = models.map((model) => model.id)
        ctx.emit('llm/models-updated', PROVIDER_ID)
      }
    } catch (error) {
      ctx.logger?.warn?.(`${LOG_TAG} model listing failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.effect(() => {
    const minutes = read().advanced.modelsRefreshMinutes
    const timer = setInterval(() => void refreshCatalog(), minutes * 60000)
    // Never keep a short-lived host (or a test process) alive for a catalog poll.
    timer.unref?.()
    void refreshCatalog()
    return () => clearInterval(timer)
  })

  ctx.on('loader/volatile-update', () => {
    usage.invalidate()
    void refreshCatalog()
  })


  // ---- Mistral platform tools ---------------------------------------------
  // Bundled here so one plugin gives a profile both the provider and the
  // endpoints worth offloading work to (OCR, embeddings, FIM, batch, usage).

  const toolConfig = read()
  const ocrModel = toolConfig.ocrModel ?? 'mistral-ocr-latest'
  const embedModel = toolConfig.embedModel ?? 'codestral-embed'
  const fimModel = toolConfig.fimModel ?? 'codestral-latest'

ctx.tools.register(
  defineTool({
    name: 'mistral_ocr',
    description:
      'Extract text and structure from a PDF or image using Mistral OCR, returning markdown. Use this instead of reading a PDF or screenshot as an image: it is cheaper, returns tables and headings, and keeps the result searchable. Accepts a public URL or a local file path.',
    parameters: {
      source: {
        type: 'string',
        description: 'Public https URL, or a local file path (PDF/PNG/JPEG) to upload inline.',
      },
      tableFormat: {
        type: 'string',
        description: 'Table rendering: "markdown", "html", or omit to inline as markdown.',
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => toolJson(v) },
    async execute(args, exec) {
      const source = String(args.source ?? '').trim()
      if (source === '') throw new Error('source is required')

      let document
      if (/^https?:\/\//i.test(source)) {
        document = { type: 'document_url', document_url: source }
      } else {
        const { readFile } = await import('node:fs/promises')
        const bytes = await readFile(source)
        const ext = source.toLowerCase().endsWith('.pdf') ? 'pdf' : 'png'
        document = { type: 'document_url', document_url: `data:application/${ext};base64,${bytes.toString('base64')}` }
      }

      const body = { model: ocrModel, document }
      if (typeof args.tableFormat === 'string' && args.tableFormat !== '') {
        body.table_format = args.tableFormat
      }
      const result = await callMistral(config, '/ocr', body, { signal: exec.signal })
      const pages = Array.isArray(result?.pages) ? result.pages : []
      return {
        pages: pages.length,
        markdown: pages.map((page) => page?.markdown ?? '').join('\n\n'),
        usage: result?.usage_info ?? null,
      }
    },
  }),
)

// ---- Embeddings --------------------------------------------------------

ctx.tools.register(
  defineTool({
    name: 'mistral_embed',
    description:
      'Embed one or more texts with Mistral code embeddings for semantic search, clustering, or duplicate detection. Returns vectors plus their dimension.',
    parameters: {
      input: {
        type: 'array',
        description: 'Texts or code snippets to embed.',
        items: { type: 'string' },
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => toolJson(v) },
    async execute(args, exec) {
      const input = Array.isArray(args.input) ? args.input.map(String) : []
      if (input.length === 0) throw new Error('input must be a non-empty array')
      const result = await callMistral(config, '/embeddings', { model: embedModel, input }, { signal: exec.signal })
      const data = Array.isArray(result?.data) ? result.data : []
      return {
        count: data.length,
        dimensions: data[0]?.embedding?.length ?? 0,
        vectors: data.map((entry) => entry.embedding),
      }
    },
  }),
)

// ---- Fill-in-the-middle ------------------------------------------------

ctx.tools.register(
  defineTool({
    name: 'mistral_fim',
    description:
      'Fast fill-in-the-middle code completion with Codestral. Give the code before the cursor and optionally the code after it; returns only the middle. Use for quick completions instead of a full agent turn.',
    parameters: {
      prompt: { type: 'string', description: 'Code before the cursor.' },
      suffix: { type: 'string', description: 'Optional code after the cursor.' },
      maxTokens: { type: 'number', description: 'Max tokens to generate (default 256).' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => toolJson(v) },
    async execute(args, exec) {
      const prompt = String(args.prompt ?? '')
      if (prompt === '') throw new Error('prompt is required')
      const body = {
        model: fimModel,
        prompt,
        suffix: typeof args.suffix === 'string' ? args.suffix : '',
        max_tokens: Number.isInteger(args.maxTokens) ? args.maxTokens : 256,
      }
      const result = await callMistral(config, '/fim/completions', body, { signal: exec.signal })
      const choice = result?.choices?.[0]
      return {
        completion: choice?.message?.content ?? '',
        finishReason: choice?.finish_reason ?? null,
        usage: result?.usage ?? null,
      }
    },
  }),
)

// ---- Batch -------------------------------------------------------------

ctx.tools.register(
  defineTool({
    name: 'mistral_batch_submit',
    description:
      'Submit an asynchronous Mistral batch job at a 50% discount. Use for many independent prompts where latency does not matter. Returns a job id; poll it with mistral_batch_status.',
    parameters: {
      requests: {
        type: 'array',
        description: 'Inline requests, each {custom_id, body:{messages:[...]}}. Max 10,000.',
        items: { type: 'object', additionalProperties: true },
      },
      model: { type: 'string', description: 'Model for the whole batch.' },
      endpoint: { type: 'string', description: 'Target endpoint, default /v1/chat/completions.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => toolJson(v) },
    async execute(args, exec) {
      const requests = Array.isArray(args.requests) ? args.requests : []
      if (requests.length === 0) throw new Error('requests must be a non-empty array')
      if (requests.length > 10000) throw new Error('inline batches are capped at 10,000 requests')
      const body = {
        requests,
        model: String(args.model ?? ''),
        endpoint: typeof args.endpoint === 'string' && args.endpoint !== '' ? args.endpoint : '/v1/chat/completions',
      }
      if (body.model === '') throw new Error('model is required')
      const result = await callMistral(config, '/batch/jobs', body, { signal: exec.signal })
      return { id: result?.id ?? null, status: result?.status ?? null, total: requests.length }
    },
  }),
)

ctx.tools.register(
  defineTool({
    name: 'mistral_batch_status',
    description: 'Check a Mistral batch job: status, counts, and output file id once complete.',
    parameters: {
      jobId: { type: 'string', description: 'Batch job id from mistral_batch_submit.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => toolJson(v) },
    async execute(args, exec) {
      const jobId = String(args.jobId ?? '').trim()
      if (jobId === '') throw new Error('jobId is required')
      const result = await callMistral(config, `/batch/jobs/${encodeURIComponent(jobId)}`, undefined, {
        method: 'GET',
        signal: exec.signal,
      })
      return {
        id: result?.id ?? jobId,
        status: result?.status ?? null,
        totalRequests: result?.total_requests ?? null,
        succeededRequests: result?.succeeded_requests ?? null,
        failedRequests: result?.failed_requests ?? null,
        outputFile: result?.output_file ?? null,
        errorFile: result?.error_file ?? null,
      }
    },
  }),
)

// ---- Subscription usage ------------------------------------------------

ctx.tools.register(
  defineTool({
    name: 'mistral_usage',
    description:
      'Read the Mistral subscription budget: Vibe Pro and API monthly allowances, percent used, and reset date. Use before large batches to check remaining quota.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_a, v) => toolJson(v) },
    async execute(_args, exec) {
      const result = await callMistral(config, '/billing/budget', undefined, {
        method: 'GET',
        signal: exec.signal,
      })
      return result
    },
  }),
)

  ctx.inject(['webServer'], (child) => {
    const route = (path, handler) =>
      child.effect(() =>
        child.webServer.register({
          kind: 'prefix',
          path: `${ROUTE_PREFIX}${path}`,
          resource: handler,
        }),
      )

    /** Account facts safe for the browser: refs and presence, never key values. */
    const accountFacts = async (current) => {
      const credentials = ctx.get('credentials')
      const facts = []
      for (const account of current.accounts) {
        let configured = false
        try {
          if (credentials !== undefined) {
            const info = await credentials.describe(account.apiKeyEnv)
            configured = info.configured
          } else {
            configured = (process.env[account.apiKeyEnv] ?? '') !== ''
          }
        } catch {
          configured = false
        }
        facts.push({
          name: account.name,
          apiKeyEnv: account.apiKeyEnv,
          baseURL: account.baseURL,
          enabled: account.enabled,
          configured,
          coolingUntil: pool.coolingUntil(account.name) ?? null,
          primary: pool.promoted === account.name,
        })
      }
      return facts
    }

    route('/health', async () => {
      const current = read()
      const clientModules = ctx.get('clientModules')
      return json({
        ok: true,
        provider: PROVIDER_ID,
        displayName: DISPLAY_NAME,
        settingsNs,
        accounts: await accountFacts(current),
        models: resolveCatalog(current, discovered.models).length,
        discovered: discovered.ids.length,
        providers: ctx.llm.listProviders().map((provider) => provider.id),
        clientPath: clientModules?.clientPath?.(name) ?? null,
      })
    })

    route('/cost', async () => {
      const current = read()
      // `tokenMeter` registers a `tokenUsage` session projection whose state is
      // { totals: {uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}, last }.
      // `sessionProjections.stateOf(session, key)` is the read path.
      const projections = ctx.get('sessionProjections')
      const turns = []
      try {
        const sessions = ctx.get('sessions')
        const list = typeof sessions?.list === 'function' ? await sessions.list({ limit: 50 }) : []
        for (const entry of Array.isArray(list) ? list : []) {
          const handle = entry?.session ?? entry
          if (handle === undefined) continue
          const state = projections?.stateOf?.(handle, 'tokenUsage')
          const totals = state?.totals
          if (totals === undefined || totals === null) continue
          // The routed model is not on the session header or the projection; it
          // is recorded per request as a `request/header` event, whose
          // data.header.config carries { provider, model, reasoningEffort }.
          const model = (() => {
            try {
              const snap = handle?.eventsSnapshot ?? []
              for (let i = snap.length - 1; i >= 0; i -= 1) {
                const event = snap[i]
                if (event?.type !== 'request/header') continue
                const id = event?.data?.header?.config?.model
                if (typeof id === 'string' && id !== '') return id
              }
            } catch {
              // Fall through to the configured default.
            }
            return current.models?.default ?? ''
          })()
          turns.push({
            model: String(model),
            usage: {
              inputTokens: (totals.uncachedInputTokens ?? 0) + (totals.cacheReadTokens ?? 0),
              outputTokens: totals.outputTokens ?? 0,
              cacheReadTokens: totals.cacheReadTokens ?? 0,
              cacheWriteTokens: totals.cacheWriteTokens ?? 0,
            },
          })
        }
      } catch {
        // A host without the projection registry simply reports no cost.
      }
      const summary = summarizeCost(turns)
      return json({
        ok: true,
        provider: PROVIDER_ID,
        showCost: current.usage.showCost !== false,
        total: summary.total,
        totalLabel: summary.totalLabel,
        cacheSavings: summary.cacheSavings,
        cacheSavingsLabel: summary.cacheSavingsLabel,
        byModel: summary.byModel,
        turns: turns.length,
      })
    })

    route('/settings', async () => {
      const settings = ctx.get('settings')
      if (settings === undefined) return json({ ok: false, error: 'settings service unavailable' })
      const described = settings.describe({ redactSecrets: true })
      const view = described.find((entry) => entry.ns === settingsNs)
      return json({
        ok: view !== undefined,
        ns: settingsNs,
        revision: view?.revision ?? null,
        value: view?.value ?? null,
        schemaKeys: view?.schema === undefined ? null : Object.keys(view.schema ?? {}),
      })
    })

    route('/refresh', async () => {
      await refreshCatalog()
      return json({ ok: true, discovered: discovered.ids.length })
    })

    route('/client', async () => {
      const clientModules = ctx.get('clientModules')
      const graph = clientModules?.graph?.()
      if (graph === undefined) return json({ ok: false, error: 'client modules unavailable' })
      return json({
        ok: true,
        clientPath: clientModules.clientPath?.(name) ?? null,
        batches: (graph.batches ?? []).map((batch) => ({
          phase: batch.phase,
          url: batch.url,
          modules: (batch.modules ?? []).map((module) => module.id ?? module.name ?? String(module)),
        })),
      })
    })

    route('/models', async () => {
      const current = read()
      const models = resolveCatalog(current, discovered.models).map((model) => ({
        id: model.id,
        name: model.name,
        description: model.description,
        visible: isVisible(model, current),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input,
        reasoningEfforts: model.reasoning.map((effort) => effort.id),
        defaultReasoning: model.defaultReasoning,
        deprecated: model.deprecated === true,
      }))
      return json({ ok: true, models })
    })

    route('/usage', async (request) => {
      const url = new URL(request.url)
      const account = url.searchParams.get('account') ?? undefined
      const force = url.searchParams.get('force') === '1'
      try {
        return json(await usage.fetchUsage(account, { force }))
      } catch (error) {
        return json({
          ok: false,
          fetchedAt: Date.now(),
          error: { code: 'USAGE_FAILED', message: error instanceof Error ? error.message : String(error) },
        })
      }
    })

    route('/test', async (request) => {
      const url = new URL(request.url)
      const current = read()
      const name = url.searchParams.get('account') ?? current.accounts[0]?.name
      const account = current.accounts.find((entry) => entry.name === name)
      if (account === undefined) return json({ ok: false, error: { code: 'NO_ACCOUNT', message: 'Unknown account.' } })
      try {
        const apiKey = await resolveAccountKey(ctx, account)
        const response = await fetch(`${account.baseURL}/models`, {
          headers: { ...attributionHeaders(), authorization: `Bearer ${apiKey}`, accept: 'application/json' },
          signal: AbortSignal.timeout(10000),
        })
        if (!response.ok) {
          return json({ ok: false, error: { code: 'PROVIDER_HTTP', message: `Provider answered ${response.status}.` } })
        }
        const payload = await response.json()
        const count = Array.isArray(payload?.data) ? payload.data.length : 0
        return json({ ok: true, count })
      } catch (error) {
        return json({
          ok: false,
          error: {
            code: error?.code ?? 'TEST_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        })
      }
    })

    route('/meta', async () => {
      const current = read()
      return json({
        ok: true,
        provider: PROVIDER_ID,
        settingsNs,
        baseURL: current.baseURL,
        usage: {
          display: current.usage.display,
          refreshSeconds: current.usage.refreshSeconds,
          adminCookieEnv: current.usage.adminCookieEnv,
          showCredits: current.usage.showCredits,
        },
        advanced: current.advanced,
        accounts: await accountFacts(current),
      })
    })
  })

  ctx.logger?.info?.(`${LOG_TAG} registered provider "${PROVIDER_ID}"`)
}

