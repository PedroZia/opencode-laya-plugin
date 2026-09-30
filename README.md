# opencode-laya-plugin

Plugin do [OpenCode](https://opencode.ai) que dá aos modelos um **System One local** para
micro-decisões: a tool `laya_decide` delega classificações, roteamento, pontuação de
risco/urgência e perguntas sim/não calibradas para a **[Laya](https://huggingface.co/convaiinnovations/laya)** —
um modelo open-weight que roda 100% na sua máquina (~30–80 ms por decisão em GPU,
com **zero tokens de nuvem**).

A Laya é uma alternativa aberta ao [Jev](https://www.jevtypesafeai.com/) da TypeSafe AI: ela não
gera texto — você entrega um *estado* (texto/JSON) e *perguntas tipadas* (`choice`, `score`,
`noul`) e recebe respostas estruturadas com probabilidades calibradas em uma única passada.

## Instalação rápida (Windows)

**Requisitos:** Windows 10/11, [uv](https://docs.astral.sh/uv/) (o instalador oferece instalar via
winget), ~5 GB de disco. **GPU NVIDIA é opcional** — sem ela a Laya roda em CPU
(mais lenta: 0,3–2 s por decisão).

```powershell
git clone https://github.com/PedroZia/opencode-laya-plugin.git
cd opencode-laya-plugin
.\install.ps1
```

O instalador:

1. cria o venv em `%USERPROFILE%\.config\opencode\laya\.venv` (Python 3.12 via uv);
2. instala PyTorch com detecção automática de CUDA (`--torch-backend=auto`) e `laya[serve]`;
3. copia o plugin para `%USERPROFILE%\.config\opencode\plugins\laya\index.ts`
   (com backup automático da versão anterior);
4. opcionalmente baixa os pesos (~1,7 GB) e roda um smoke test.

Depois é só abrir o OpenCode — **o servidor local sobe sozinho** quando o plugin carrega.

| Ação | Comando |
|---|---|
| Atualizar | `git pull` e rode `.\install.ps1` de novo (preserva o venv) |
| Reinstalar do zero | `.\install.ps1 -Force` |
| Pular o download inicial | `.\install.ps1 -SkipSmoke` |
| Desinstalar | `.\uninstall.ps1` |

## Uso

| Recurso | O que faz |
|---|---|
| Tool `laya_decide` | o modelo delega micro-decisões: use um `preset` (`triage`, `risco`, `complexidade`) ou monte perguntas customizadas (`choice`/`score`/`noul`) |
| Comando `/laya-status` | saúde do servidor, latência e contagem de decisões (métricas persistentes) |
| Dica automática | o plugin injeta uma linha no system a cada request lembrando o modelo de usar a tool |
| Auto-start | se o servidor não estiver no ar, o plugin sobe sozinho (logs em `~/.config/opencode/laya/logs/`) |
| Cache | decisões repetidas retornam na hora (TTL de 1 h) |

Você **não precisa** pedir sempre: o modelo tende a usar a tool quando a tarefa é claramente uma
decisão ("classifique", "pontue o risco disso", "é urgente?"). Pedido explícito também funciona:
*"use `laya_decide` para classificar este ticket"*.

Exemplo de resposta da tool:

```
Laya 29ms | modelo multilingual | threshold 0.6
- department: "billing" (conf 0.96) [billing 97% | technical 1% | sales 2% | other 1%] → agir
- urgency: 1.82 (conf 0.83) [0 1% | 1 16% | 2 83%] → agir
```

`escalar` = confiança abaixo do threshold (padrão 0,60): a orientação é o modelo decidir por conta
própria ou perguntar ao usuário — esse é o contrato "código decide, Laya sugere".

## Usar com Claude Code, Codex CLI e outros clientes (MCP)

A Laya também é distribuída com um **servidor MCP oficial** (`laya-mcp-server`), então o mesmo motor
de decisões atende qualquer cliente compatível com MCP — Claude Code, Codex CLI/IDE, Gemini CLI,
Cursor, Claude Desktop, entre outros. Para esses clientes, **nada deste repositório é necessário**:
eles falam direto com o servidor MCP da Laya.

O `install.ps1` já instala o extra `laya[mcp]`. Tools expostas:
`laya_predict`, `laya_predict_batch`, `laya_route`, `laya_route_batch`, `laya_shortlist`,
`laya_preset`, `laya_decide` e `laya_status`.

Teste rápido (handshake MCP + uma decisão real):

```powershell
& "$env:USERPROFILE\.config\opencode\laya\.venv\Scripts\python.exe" tools\mcp-smoke.py
```

### Claude Code

```powershell
claude mcp add --scope user laya -- "$env:USERPROFILE\.config\opencode\laya\.venv\Scripts\laya-mcp-server.exe"
claude mcp list   # deve mostrar: laya ... ✓ Connected
```

### Codex CLI

```powershell
codex mcp add laya --env LAYA_PRELOAD=0 -- "$env:USERPROFILE\.config\opencode\laya\.venv\Scripts\laya-mcp-server.exe"
```

Ou direto no `~/.codex/config.toml`:

```toml
[mcp_servers.laya]
command = 'C:\Users\<voce>\.config\opencode\laya\.venv\Scripts\laya-mcp-server.exe'
args = []
enabled = true
tool_timeout_sec = 120

[mcp_servers.laya.env]
LAYA_PRELOAD = "0"
```

### Dica de uso (equivalente ao "hint" do plugin do OpenCode)

Em clientes que aceitam instruções persistentes, adicione ao `CLAUDE.md` / `AGENTS.md`:

```md
## Decisões rápidas (Laya)
Para micro-julgamentos objetivos (classificar, rotear, pontuar risco/urgência, sim/não), prefira as
tools MCP `laya_predict` / `laya_preset` / `laya_decide` em vez de raciocinar longamente. Confie
quando a confiança for alta; escale (decida você mesmo ou pergunte ao usuário) quando for baixa.
```

### Memória/VRAM por cliente

Cada cliente MCP sobe o próprio processo e carrega os seus próprios checkpoints (por padrão, com
preload). Se rodar OpenCode + Claude Code + Codex ao mesmo tempo, limite o consumo em cada
configuração com `LAYA_MODELS=english,multilingual` e/ou `LAYA_PRELOAD=0` (carregamento sob demanda).

## Privacidade

**Tudo roda local.** Os estados enviados às decisões nunca saem da sua máquina; não há API key nem
nuvem envolvida. O servidor escuta apenas em `127.0.0.1`. Os únicos acessos de rede acontecem na
instalação/primeiro uso: download do PyTorch, do pacote `laya` e dos pesos pelo Hugging Face.

## Como funciona (arquitetura)

```
┌─────────────────────────────────────────────────────────────────────┐
│ OpenCode (server)                                                   │
│                                                                     │
│  plugin "laya"  ~/.config/opencode/plugins/laya/index.ts            │
│  ├─ cliente HTTP local (timeout ~2,5 s, degradação graciosa)        │
│  ├─ tool  laya_decide        ← o LLM chama para choice/score/noul   │
│  ├─ hook  session.context    → dica curta no system                 │
│  ├─ hook  permission.evaluate→ guardrail opt-in (desligado, ver §)  │
│  └─ comando /laya-status     → saúde, latência, contagem            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ POST http://127.0.0.1:8000/v1/systemone
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ laya-serve (serviço local, Python + CUDA, iniciado pelo plugin)     │
│  ~/.config/opencode/laya/  (venv, serve.cmd, logs)                  │
│  checkpoints pré-carregados: english + multilingual + typed         │
│  Router: texto em português → checkpoint multilingual               │
└─────────────────────────────────────────────────────────────────────┘
```

Hardware: testado numa RTX 2000 Ada (16 GB). Checkpoints pré-carregados ocupam ~3 GB de VRAM.
Em CPU funciona com fallback automático, mas com latência de 0,3–2 s por decisão.

## Decisões de projeto (e por quê)

| # | Decisão | Justificativa |
|---|---|---|
| 1 | **Runtime: `laya-serve` oficial** (Python + FastAPI) | Protocolo estável `POST /v1/systemone` (mesmo formato da API hospedada do Jev), mantém os checkpoints carregados uma única vez e faz roteamento multilíngue automático. As alternativas (`ollaya`, ONNX in-process) ou são menos canônicas ou carregariam ~2 GB de RAM dentro do processo do OpenCode. |
| 2 | **O plugin sobe o servidor automaticamente** | No `setup`, se o health check falhar, o plugin sobe o `laya-serve` (processo detached, env CUDA) com log em arquivo. Zero fricção; se o servidor já estiver rodando (manual/serviço), o plugin apenas usa. |
| 3 | **Bind em `127.0.0.1`** | `laya-serve` por padrão escuta em `0.0.0.0` — exposto na rede local. Fixamos `LAYA_HOST=127.0.0.1` para ficar 100% local. |
| 4 | **Checkpoint multilíngue via Router** | Prompts e código em português; o Router manda não-inglês para `laya-multilingual` automaticamente. Sem isso, o checkpoint inglês "colapsa" fora do idioma dele. |
| 5 | **Guardrail implementado, mas desligado** | Os checkpoints vêm *overconfident* e o `multilingual` sem temperaturas calibradas. A calibração de 30/09/2026 (~160 inferências, ver §Testes) mostrou que a Laya **não separa comando seguro de perigoso** — permanece desligado. |
| 6 | **Guardrail só ESCALA (`allow → ask`); nunca auto-libera** | Segurança por construção: uma decisão errada da Laya pode no máximo gerar um prompt extra; jamais concede acesso sozinha. `deny` configurado pelo usuário continua final. |
| 7 | **Timeout curto (~2,5 s) + degradação graciosa** | Laya é assistente, não dependência dura. Servidor offline → a tool devolve erro claro e o fluxo do OpenCode segue normal. |
| 8 | **Dica no `system` (hook `context`)** | Sem hint, o modelo não sabe que a tool existe nem quando usá-la. Uma linha fixa e barata muda o comportamento de uso. |
| 9 | **Cache de decisões em `ctx.storage`** | Estados repetidos (loop de classificação, mesmo comando) retornam na hora, com 0 ms e 0 tokens. Chave = hash de `state+questions`; TTL de 1 h. |
| 10 | **Resposta com `confiança` e recomendação `agir`/`escalar`** | Probabilidade bruta não ensina o modelo a agir. A recomendação (threshold padrão 0,6, ajustável por chamada) dá a semântica de "quando confiar na Laya e quando pensar melhor". |
| 11 | **Presets embutidos: `triage`, `risco`, `complexidade`** | Cobrem os casos mais comuns de delegação sem exigir que o modelo monte o JSON de perguntas na mão. Perguntas livres continuam disponíveis. |
| 12 | **Métricas persistentes em `laya/stats/v1`** | Gravação por delta no storage: decisões/cache/erros sobrevivem a hot-reload, restart do serviço e agregam entre sessões. |
| 13 | **`USE_TF=0` no ambiente do servidor** | Evita um deadlock conhecido do runtime do TensorFlow no carregamento do modelo (a `transformers` sonda TF no import). |

## A API da Laya usada

### Requisição

```http
POST http://127.0.0.1:8000/v1/systemone
Content-Type: application/json

{
  "state": { "body": "cobrado duas vezes na fatura 4411, quero reembolso" },
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which department should handle this?",
      "criteria": { "billing": "invoices, payments, refunds", "technical": "bugs and outages" }
    },
    "urgency": {
      "type": "score",
      "instructions": "How urgent is this?",
      "criteria": ["not urgent", "soon", "blocking"]
    },
    "churn_risk": {
      "type": "noul",
      "instructions": "Does the user threaten to cancel?"
    }
  }
}
```

### Resposta

```json
{
  "answers": {
    "department": { "type": "choice", "choice": "billing", "confidence": 0.8,
                    "answer_confidence": 0.87, "probabilities": { "billing": 0.87, "technical": 0.13 } },
    "urgency":    { "type": "score", "score": 1.04, "legend": { "0": "not urgent", "1": "soon", "2": "blocking" },
                    "probabilities": { "0": 0, "1": 0.96, "2": 0.04 } },
    "churn_risk": { "type": "noul", "noul": 0.95 }
  },
  "usage":   { "input_tokens": 426, "output_tokens": 0, "truncated": false },
  "routing": { "model": "multilingual" }
}
```

Extras úteis confirmados no servidor: `GET /health` (barato, sem inferência), `POST /v1/systemone/batch`,
e campos opcionais no corpo: `model` (`english` | `multilingual` | `typed-decisions`), `task`, `lang`,
`min_confidence`, `max_len`, `head_max_len`.

Limites no design das perguntas: contexto de 512 tokens (inglês) / 1024 (multilíngue, typed);
instruções + opções de um `choice` compartilham ~192 tokens (rótulo ≤ 48 tokens, ≤ ~20 opções);
estados curtos → menos latência.

## Integração com o OpenCode (hooks V2)

| Recurso | Uso no plugin |
|---|---|
| `ctx.tool.transform(...)` | registra a tool `laya_decide` que o **LLM** chama |
| `ctx.session.hook("context")` | injeta a dica no `system` a cada request |
| `ctx.permission.hook("evaluate")` | guardrail opt-in (desligado): só eleva `allow → ask` |
| `ctx.command.transform(...)` | registra `/laya-status` |
| `ctx.storage` | cache de decisões (1 h) + métricas acumuladas |
| `ctx.session.synthetic(...)` | resposta do `/laya-status` na sessão |

## Estrutura do repositório

```
opencode-laya-plugin/
├─ plugin/index.ts     # o plugin completo (tool, hooks, comando) — instalado em
│                      #   %USERPROFILE%\.config\opencode\plugins\laya\index.ts
├─ install.ps1         # instalador Windows (uv → venv → deps → plugin → smoke test)
├─ uninstall.ps1       # desinstalador (com confirmação; não toca nos pesos do HF)
├─ tools/
│  ├─ smoke.py         # teste direto (sem servidor), mede latência EN/PT
│  ├─ mcp-smoke.py     # teste do servidor MCP oficial (handshake + decisão real)
│  └─ calibrate*.py    # experimentos de calibração do guardrail (ver §Testes)
└─ LICENSE             # MIT
```

Instalado na sua máquina:

```
%USERPROFILE%\.config\opencode\
├─ plugins\laya\index.ts      # o plugin
└─ laya\
   ├─ .venv\                  # Python 3.12 + laya[serve] + torch
   ├─ serve.cmd               # subir o servidor manualmente (opcional)
   └─ logs\
      ├─ serve.log            # saída do servidor Python
      └─ plugin.log           # log do plugin
```

## Testes e calibração (resultados reais)

### Fase 0 — serviço local

torch 2.14.0+cu132, laya 0.3.22, transformers 5.17.0. `/health`: 3 checkpoints em CUDA,
zero fallbacks para CPU. Latência via HTTP com preload: **EN 37–39 ms, PT 28–77 ms**, sem
penalidade ao alternar idioma.

### Fase 1 — plugin

`laya_decide`: preset `triage` em PT-BR roteado para o checkpoint *multilingual* (`billing` 97%,
urgência 1.82); perguntas customizadas com recomendação `escalar` quando a confiança fica abaixo do
threshold; repetição devolve cache instantâneo. Resiliência: servidor morto → erro amigável em ~4 s
e respawn automático em ~1 min. `/laya-status` com métricas persistentes. Hot-reload do plugin sem
reiniciar o serviço.

### Fase 2 — calibração do guardrail (veredito: desligado)

Três rodadas (~160 inferências) testando 8 formulações, 3 checkpoints e a convenção oficial do
pacote (estado como dict + campo citado com backticks + critérios ricos):

- preset original em PT → ruído puro (`rg "TODO"` deu 0,93 e `git reset --hard` deu 0,008);
- todas as formulações com sobreposição entre seguro/perigoso;
- melhor caso (`typed-decisions` + `needs_review`) com gap ≈ 0: `rm -rf /` (0,435) e `ls -la` (0,449)
  na mesma faixa.

**Conclusão**: a Laya é forte em decisões sobre **texto** (triagem funcionou muito bem), fraca em
**semântica de comando shell** (fora da distribuição de treino). O guardrail fica implementado e
desligado; os scripts `tools/calibrate*.py` ficam para reavaliar com modelos/presets futuros.

## Limitações conhecidas

- **Windows apenas, por enquanto** (instalador e caminhos do plugin). macOS/Linux: a instalação
  manual funciona (ver abaixo), mas o auto-start do plugin assume `.venv\Scripts`. O servidor MCP
  da Laya, porém, funciona em qualquer sistema — veja a seção de MCP.
- **Julgamento de comando shell não é confiável** — não use esta tool para decidir permissões
  (foi exatamente o que a calibração mostrou).
- **CPU é lento** (0,3–2 s/decisão) — em máquinas sem NVIDIA, reduza os checkpoints carregados
  (`LAYA_MODELS=english,multilingual`) e ajuste expectativas.
- O checkpoint `multilingual` emite um aviso de temperaturas inválidas ("confidence uncalibrated")
  no carregamento — thresholds conservadores são recomendados.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Laya overconfident | thresholds conservadores; recomendação explícita `agir`/`escalar`; guardrail desligado |
| Latência alta em CPU / estados longos | estados curtos; timeout de 2,5 s; cache; fallback gracioso |
| Servidor cai / porta ocupada | health check + auto-start + degradação graciosa (nunca bloqueia a sessão) |
| `laya-serve` exposto na rede | bind fixo em `127.0.0.1` no spawn e no `serve.cmd` |
| Deadlock do TensorFlow no load | `USE_TF=0` no ambiente do servidor |

## Instalação manual (macOS/Linux e troubleshooting)

```bash
# 1) serviço
uv venv --python 3.12 ~/.config/opencode/laya/.venv
uv pip install --python ~/.config/opencode/laya/.venv/bin/python --torch-backend=auto torch
uv pip install --python ~/.config/opencode/laya/.venv/bin/python "laya[serve]"

# 2) plugin
mkdir -p ~/.config/opencode/plugins/laya
cp plugin/index.ts ~/.config/opencode/plugins/laya/index.ts

# 3) subir o servidor (o plugin também tenta; no macOS/Linux ajuste o caminho do venv no plugin)
LAYA_DEVICE=cuda LAYA_PRELOAD=1 LAYA_HOST=127.0.0.1 USE_TF=0 laya-serve
```

## Créditos e licença

- **Plugin**: MIT — veja [LICENSE](LICENSE).
- **[Laya](https://huggingface.co/convaiinnovations/laya)** (ConvAI Innovations): Apache-2.0 —
  os pesos são baixados na instalação e não são redistribuídos aqui.
- **[Jev](https://www.jevtypesafeai.com/)** (TypeSafe AI): inspiração para o conceito de
  System One / decisões tipadas.

## Referências

- Guia "run Laya locally": <https://laya.tools/guides/run-laya-locally>
- Modelo no Hugging Face: <https://huggingface.co/convaiinnovations/laya>
- Plugins OpenCode V2: <https://opencode.ai/v2/docs/build/plugins>
