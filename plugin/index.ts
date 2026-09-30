import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { openSync, mkdirSync, appendFileSync, existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { Plugin } from "@opencode/plugin"

// Plugin global: integra o modelo local de decisões Laya (System One, estilo Jev).
//
// O que faz:
//  1. tool `laya_decide` — o modelo delega micro-decisões (classificar, rotear,
//     pontuar risco/urgência/complexidade, sim/não) e recebe resposta tipada com
//     probabilidades calibradas em ~30-80 ms, sem gastar tokens de raciocínio.
//  2. dica no system (hook `context`) para o modelo saber que a tool existe.
//  3. guardrail opcional de permissões (`permission.evaluate`): se a Laya achar a
//     ação arriscada, ESCALA allow -> ask. Nunca auto-libera nada. DESLIGADO por
//     padrão até calibrarmos os thresholds (os checkpoints vêm overconfident).
//  4. comando /laya-status com saúde do servidor + métricas.
//
// O servidor local (laya-serve, Python + CUDA) é iniciado automaticamente quando
// o health check falha. Instalação: https://github.com/PedroZia/opencode-laya-plugin

// ---------------------------------------------------------------- configuração

const LAYA_URL = process.env.LAYA_URL ?? "http://127.0.0.1:8000"
const LAYA_DIR = join(homedir(), ".config", "opencode", "laya")
const LOG_FILE = join(LAYA_DIR, "logs", "serve.log")
const PLUGIN_LOG = join(LAYA_DIR, "logs", "plugin.log")
const SERVE_EXE = join(LAYA_DIR, ".venv", "Scripts", "laya-serve.exe")

// Log em arquivo: o console do plugin não é capturado pelo log do serviço.
function log(msg: string, err = false): void {
  const line = `${new Date().toISOString()} ${msg}\n`
  try {
    appendFileSync(PLUGIN_LOG, line)
  } catch {}
  if (err) console.error(`[laya] ${msg}`)
  else console.log(`[laya] ${msg}`)
}

const REQUEST_TIMEOUT_MS = 2_500 // decisão individual
const START_TIMEOUT_MS = 150_000 // espera o servidor ficar pronto depois do spawn
const CONFIDENCE_THRESHOLD = 0.6 // abaixo disso, recomendamos "escalar"
const CACHE_TTL_MS = 60 * 60 * 1000

const INJECT_HINT = true // dica no system; sem ela o modelo não usa a tool
// Calibração de 30/09/2026: o guardrail foi REPROVADO para comandos (8 formulações testadas,
// todas com sobreposição entre seguro/perigoso). Mantido desligado até existir um preset melhor.
// Detalhes: ~/Documents/laya-plugin/README.md, seção Fase 2.
const GUARDRAIL = false
const GUARD_ACTIONS = ["bash", "edit", "write", "patch"]
const RISK_THRESHOLD = 0.7

// ------------------------------------------------------------------- presets

type QuestionType = "choice" | "score" | "noul"
type Question = {
  type: QuestionType
  instructions: string
  criteria?: unknown
}

const PRESETS: Record<string, Record<string, Question>> = {
  triage: {
    department: {
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: {
        billing: "invoices, payments, refunds, subscriptions",
        technical: "bugs, outages, system errors",
        sales: "pricing, plans, upgrades",
        other: "everything else",
      },
    },
    urgency: {
      type: "score",
      instructions: "How urgent is this?",
      criteria: ["not urgent", "soon", "blocking"],
    },
    churn_risk: {
      type: "noul",
      instructions: "Does the sender threaten to cancel, leave, or escalate badly?",
    },
  },
  // ATENÇÃO: este preset NÃO é usado para decidir permissões (o guardrail está desligado).
  // A calibração (laya/calibrate*.py, 30/09/2026) mostrou que a Laya não separa comandos
  // seguros de perigosos — outputs aqui servem só como sinal auxiliar para o LLM.
  risco: {
    destructive: {
      type: "noul",
      instructions:
        "Could this action destroy data, break the system, leak secrets, or be irreversible?",
    },
    risky_category: {
      type: "choice",
      instructions: "What kind of risk does this action carry?",
      criteria: {
        none: "safe, read-only or trivially reversible",
        filesystem: "writes or deletes files",
        network: "sends data out or fetches remote resources",
        execution: "runs code or system commands",
        credentials: "touches secrets, keys or permissions",
      },
    },
    reversible: {
      type: "noul",
      instructions: "Is this action trivially reversible if it goes wrong?",
    },
  },
  complexidade: {
    complexity: {
      type: "score",
      instructions: "How complex is this task?",
      criteria: ["trivial", "simple", "moderate", "complex"],
    },
    needs_plan: {
      type: "noul",
      instructions: "Does this task require planning or a multi-step approach before execution?",
    },
    parallelizable: {
      type: "noul",
      instructions: "Could this task be split into independent parallel workstreams?",
    },
  },
}

const PRESET_NAMES = Object.keys(PRESETS).join(", ")

// ------------------------------------------------------------------ cliente

type LayaAnswer = {
  type: QuestionType
  choice?: string
  score?: number
  noul?: number
  probabilities?: Record<string, number>
  confidence?: number
  answer_confidence?: number
  legend?: Record<string, string>
}

type LayaResponse = {
  answers: Record<string, LayaAnswer>
  usage?: {
    input_tokens?: number
    output_tokens?: number
    truncated?: boolean
    truncated_questions?: string[]
  }
  routing?: { model?: string }
}

type Health = { status: string; loaded: string[]; device: string }

const stats = { decisions: 0, cacheHits: 0, errors: 0, totalMs: 0, lastMs: 0 }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function ping(timeoutMs = 800): Promise<boolean> {
  try {
    const res = await fetch(`${LAYA_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

async function healthInfo(timeoutMs = 1_500): Promise<Health | null> {
  try {
    const res = await fetch(`${LAYA_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return (await res.json()) as Health
  } catch {
    return null
  }
}

let starting: Promise<boolean> | null = null
let lastSpawn = 0

// Sobe o laya-serve em background (detached) e espera ele responder.
function spawnServer(): void {
  if (!existsSync(SERVE_EXE)) {
    log(
      `laya-serve não encontrado em ${SERVE_EXE} — instale com o install.ps1 de ` +
        "https://github.com/PedroZia/opencode-laya-plugin",
      true,
    )
    return
  }
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true })
    const fd = openSync(LOG_FILE, "a")
    const child = spawn(SERVE_EXE, [], {
      cwd: LAYA_DIR,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
      env: {
        ...process.env,
        LAYA_DEVICE: process.env.LAYA_DEVICE ?? "cuda",
        LAYA_PRELOAD: process.env.LAYA_PRELOAD ?? "1",
        LAYA_HOST: "127.0.0.1",
        LAYA_PORT: "8000",
        USE_TF: "0",
        HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
      },
    })
    child.unref()
    log(`servidor iniciando em background (log: ${LOG_FILE})`)
  } catch (e) {
    log(`falha ao iniciar o servidor: ${e instanceof Error ? e.message : String(e)}`, true)
  }
}

// Garante o servidor no ar; espera no máximo waitMs (o spawn segue em background).
async function ensureServer(waitMs: number): Promise<boolean> {
  if (await ping(800)) return true
  if (!starting && Date.now() - lastSpawn > 30_000) {
    lastSpawn = Date.now()
    starting = (async () => {
      spawnServer()
      const deadline = Date.now() + START_TIMEOUT_MS
      while (Date.now() < deadline) {
        await sleep(2_000)
        if (await ping(1_500)) return true
      }
      return false
    })().finally(() => {
      starting = null
    })
  }
  if (!starting) return false
  return Promise.race([starting, sleep(waitMs).then(() => false)])
}

async function predict(
  state: string,
  questions: Record<string, Question>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<LayaResponse> {
  const signals = [AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS)]
  if (opts.signal) signals.push(opts.signal)
  const res = await fetch(`${LAYA_URL}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state, questions }),
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as LayaResponse
}

// ------------------------------------------------------------------- formatação

const pct = (p: number) => `${Math.round(p * 100)}%`

function render(resp: LayaResponse, threshold: number, ms: number, fromCache: boolean): string {
  const lines: string[] = []
  let anyEscalar = false

  for (const [name, ans] of Object.entries(resp.answers ?? {})) {
    const conf = ans.answer_confidence ?? ans.noul ?? ans.confidence ?? 0
    const rec = conf >= threshold ? "agir" : "escalar"
    if (rec === "escalar") anyEscalar = true

    let value: string
    let dist = ""
    if (ans.type === "choice" && ans.choice != null) {
      value = `"${ans.choice}"`
      const probs = Object.entries(ans.probabilities ?? {})
      dist = ` [${probs.map(([k, v]) => `${k} ${pct(v)}`).join(" | ")}]`
    } else if (ans.type === "score" && ans.score != null) {
      value = ans.score.toFixed(2)
      const probs = Object.entries(ans.probabilities ?? {})
      dist = ` [${probs.map(([k, v]) => `${k} ${pct(v)}`).join(" | ")}]`
    } else {
      const p = ans.noul ?? 0
      value = `${p.toFixed(2)} ${p >= 0.5 ? "(sim)" : "(não)"}`
    }

    lines.push(`- ${name}: ${value} (conf ${conf.toFixed(2)})${dist} → ${rec}`)
  }

  const header = [
    `Laya ${fromCache ? "(cache) " : ""}${ms}ms`,
    `modelo ${resp.routing?.model ?? "?"}`,
    `threshold ${threshold}`,
  ].join(" | ")

  const warn = resp.usage?.truncated ? "\n⚠ estado truncado pelo limite de contexto da Laya" : ""
  const note = anyEscalar
    ? "\n(escalar = confiança abaixo do threshold: decida por conta própria ou pergunte ao usuário)"
    : ""

  return `${header}\n${lines.join("\n")}${warn}${note}`
}

// ------------------------------------------------------------------- plugin

export default Plugin.define({
  id: "laya",
  async setup(ctx) {
    log(`plugin carregado (servidor: ${LAYA_URL})`)

    // -------------------------------------------- métricas persistentes
    // Contadores locais (stats) + gravação incremental em ctx.storage: cada flush soma só o
    // delta desde o último, então o total sobrevive a hot-reload, restart e múltiplas instâncias.
    // Corrida entre instâncias no pior caso subconta 1 evento — aceitável para métricas.
    type StoredStats = {
      decisions: number
      cacheHits: number
      errors: number
      totalMs: number
      lastMs: number
      firstAt: number
      lastAt: number
    }
    const STATS_KEY = "laya/stats/v1"
    const flushed = { decisions: 0, cacheHits: 0, errors: 0, totalMs: 0 }

    const readStored = async (): Promise<StoredStats | undefined> => {
      try {
        return (await ctx.storage.get(STATS_KEY)) as StoredStats | undefined
      } catch {
        return undefined
      }
    }

    const flushStats = async (): Promise<void> => {
      const delta = {
        decisions: stats.decisions - flushed.decisions,
        cacheHits: stats.cacheHits - flushed.cacheHits,
        errors: stats.errors - flushed.errors,
        totalMs: stats.totalMs - flushed.totalMs,
      }
      if (!delta.decisions && !delta.cacheHits && !delta.errors) return
      try {
        const prev = await readStored()
        const now = Date.now()
        await ctx.storage.set(STATS_KEY, {
          decisions: (prev?.decisions ?? 0) + delta.decisions,
          cacheHits: (prev?.cacheHits ?? 0) + delta.cacheHits,
          errors: (prev?.errors ?? 0) + delta.errors,
          totalMs: (prev?.totalMs ?? 0) + delta.totalMs,
          lastMs: stats.lastMs,
          firstAt: prev?.firstAt ?? now,
          lastAt: now,
        })
        // só marca como enviado depois de gravar com sucesso
        flushed.decisions = stats.decisions
        flushed.cacheHits = stats.cacheHits
        flushed.errors = stats.errors
        flushed.totalMs = stats.totalMs
      } catch {}
    }

    // Servidor: garante no ar sem bloquear o load do plugin.
    void ensureServer(1_000).then((ok) => {
      if (ok) log("servidor pronto")
      else log("servidor ainda não respondeu (segue subindo em background)")
    })

    // ------------------------------------------------------------ tool
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "laya_decide",
        description:
          "Delega uma micro-decisão objetiva ao modelo local Laya (System One): classificar, rotear, " +
          "pontuar risco/urgência/complexidade ou obter um sim/não calibrado. Rápido (~50 ms) e sem custo de tokens. " +
          "Use para julgamentos pequenos e objetivos; NÃO use para escrever código, texto ou explicações. " +
          `Passe \`state\` (texto/JSON) e \`questions\`, ou um \`preset\` pronto (${PRESET_NAMES}).`,
        input: {
          type: "object",
          properties: {
            state: {
              type: "string",
              description: "O estado a ser julgado: texto, JSON serializado, comando, diff, etc.",
            },
            preset: {
              type: "string",
              enum: Object.keys(PRESETS),
              description: "Conjunto de perguntas pronto; alternativa a montar `questions` na mão.",
            },
            questions: {
              type: "object",
              description:
                "Perguntas nomeadas. Cada uma: { type: choice|score|noul, instructions, criteria }. " +
                "choice: criteria = { rotulo: descricao }. score: criteria = [niveis ordenados]. noul: criteria opcional.",
              additionalProperties: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["choice", "score", "noul"] },
                  instructions: { type: "string", description: "A pergunta em si." },
                  criteria: {
                    description:
                      "choice: objeto rotulo->descricao. score: lista ordenada de niveis. noul: descricao de true/false (opcional).",
                  },
                },
                required: ["type", "instructions"],
                additionalProperties: false,
              },
            },
            threshold: {
              type: "number",
              description: `Confiança mínima (0-1) para recomendar "agir" em vez de "escalar". Padrão ${CONFIDENCE_THRESHOLD}.`,
            },
          },
          required: ["state"],
          additionalProperties: false,
        },
        execute: async (input, toolCtx) => {
          const args = input as {
            state: string
            preset?: string
            questions?: Record<string, { type: QuestionType; instructions: string; criteria?: unknown }>
            threshold?: number
          }

          const state = String(args.state ?? "").trim()
          if (!state) throw new Error("[laya] `state` vazio.")

          const questions: Record<string, Question> = {}
          if (args.preset) {
            const preset = PRESETS[args.preset]
            if (!preset) throw new Error(`[laya] preset desconhecido "${args.preset}" (use: ${PRESET_NAMES}).`)
            Object.assign(questions, preset)
          }
          for (const [name, q] of Object.entries(args.questions ?? {})) {
            if (!q || (q.type !== "choice" && q.type !== "score" && q.type !== "noul")) {
              throw new Error(`[laya] pergunta "${name}": type deve ser choice, score ou noul.`)
            }
            questions[name] = { type: q.type, instructions: String(q.instructions ?? name) }
            if (q.criteria !== undefined) questions[name].criteria = q.criteria
          }
          if (Object.keys(questions).length === 0) {
            throw new Error(`[laya] informe \`questions\` ou um \`preset\` (${PRESET_NAMES}).`)
          }

          const threshold = Math.min(1, Math.max(0, args.threshold ?? CONFIDENCE_THRESHOLD))

          // Cache: Laya é determinística, então repetir a mesma pergunta é grátis.
          const cacheKey = `laya/cache/v1/${createHash("sha1").update(JSON.stringify([state, questions])).digest("hex")}`
          try {
            const cached = (await ctx.storage.get(cacheKey)) as
              | { at: number; ms: number; resp: LayaResponse }
              | undefined
            if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
              stats.cacheHits++
              void flushStats()
              const content = render(cached.resp, threshold, cached.ms, true)
              return { content, metadata: { cached: true, answers: cached.resp.answers } }
            }
          } catch {}

          const up = await ensureServer(4_000)
          if (!up) {
            const hint = existsSync(SERVE_EXE)
              ? "Ele pode estar iniciando; tente de novo em ~1 min ou rode ~/.config/opencode/laya/serve.cmd manualmente."
              : "Laya não instalada: rode o install.ps1 de https://github.com/PedroZia/opencode-laya-plugin"
            throw new Error(`[laya] servidor local não respondeu em ${LAYA_URL}. ${hint}`)
          }

          const t0 = Date.now()
          let resp: LayaResponse
          try {
            resp = await predict(state, questions, { signal: (toolCtx as { signal?: AbortSignal })?.signal })
          } catch (e) {
            stats.errors++
            void flushStats()
            throw new Error(`[laya] falha na decisão: ${e instanceof Error ? e.message : String(e)}`)
          }
          const ms = Date.now() - t0
          stats.decisions++
          stats.totalMs += ms
          stats.lastMs = ms
          void flushStats()

          try {
            await ctx.storage.set(cacheKey, { at: Date.now(), ms, resp })
          } catch {}

          const content = render(resp, threshold, ms, false)
          return {
            content,
            metadata: {
              cached: false,
              ms,
              routing: resp.routing?.model,
              usage: resp.usage,
              answers: resp.answers,
            },
          }
        },
      })
    })

    // ------------------------------------------- dica no system (por request)
    if (INJECT_HINT) {
      const HINT =
        "Ferramenta local `laya_decide` disponível: delega micro-decisões objetivas " +
        "(classificar, rotear, pontuar risco/urgência/complexidade, sim/não) para um modelo local rápido " +
        "com probabilidades calibradas — prefira-a a raciocinar sobre julgamentos pequenos."
      let hintLogged = false
      await ctx.session.hook("context", (event) => {
        event.system.push({ type: "text", text: HINT })
        if (!hintLogged) {
          hintLogged = true
          log("dica injetada no system (primeira vez neste processo)")
        }
      })
    }

    // ------------------------------------------------- guardrail (opt-in)
    if (GUARDRAIL) {
      await ctx.permission.hook("evaluate", async (event) => {
        try {
          if (event.effect !== "allow") return // deny explícito é final; ask já pergunta
          if (!GUARD_ACTIONS.includes(event.action)) return
          if (!(await ensureServer(500))) return // Laya fora do ar não bloqueia nada

          const state = `Ação: ${event.action}\nRecursos:\n${event.resources.join("\n")}`
          const resp = await predict(state, PRESETS.risco, { timeoutMs: 1_500 })
          const p = resp.answers?.destructive?.noul ?? 0
          const category = resp.answers?.risky_category?.choice

          if (p >= RISK_THRESHOLD && category && category !== "none") {
            event.effect = "ask"
            event.message = `[laya] risco estimado ${pct(p)} (${category}); confirme antes de executar.`
            log(`guardrail: ${event.action} escalado (p=${p.toFixed(2)}, ${category})`)
          }
        } catch {
          // qualquer erro: mantém a decisão original
        }
      })
    }

    // ------------------------------------------------------- /laya-status
    await ctx.command.transform((editor) => {
      editor.add({
        name: "laya-status",
        description: "Mostra o status do servidor local de decisões Laya e métricas de uso",
        execute: async ({ sessionID }) => {
          const health = await healthInfo()
          const stored = await readStored()
          // total = persistido + delta ainda não gravado desta instância
          const total = {
            decisions: (stored?.decisions ?? 0) + (stats.decisions - flushed.decisions),
            cacheHits: (stored?.cacheHits ?? 0) + (stats.cacheHits - flushed.cacheHits),
            errors: (stored?.errors ?? 0) + (stats.errors - flushed.errors),
            totalMs: (stored?.totalMs ?? 0) + (stats.totalMs - flushed.totalMs),
          }
          const avg = total.decisions ? Math.round(total.totalMs / total.decisions) : 0
          const lastMs = stats.lastMs || stored?.lastMs || 0
          const text = [
            health
              ? `✅ Laya no ar (${LAYA_URL}) — device ${health.device}, checkpoints: ${health.loaded.join(", ")}`
              : `❌ Laya offline (${LAYA_URL})`,
            `Decisões: ${total.decisions} | cache hits: ${total.cacheHits} | erros: ${total.errors}`,
            total.decisions ? `Latência: última ${lastMs} ms | média ${avg} ms` : null,
            stored?.firstAt ? `Desde: ${new Date(stored.firstAt).toLocaleString("pt-BR")}` : null,
            `Guardrail de permissões: ${GUARDRAIL ? "LIGADO" : "desligado"}`,
            !health ? "Rode ~/.config/opencode/laya/serve.cmd ou aguarde o auto-start." : null,
          ]
            .filter(Boolean)
            .join("\n")
          try {
            await ctx.session.synthetic({ sessionID, text })
          } catch (e) {
            log(`falha ao responder /laya-status: ${e instanceof Error ? e.message : String(e)}`, true)
          }
        },
      })
    })
  },
})
