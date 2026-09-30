"""Smoke test da Laya: baixa os pesos, roda 1 decisão em EN e 1 em PT e mede latência.

Uso:  .venv\\Scripts\\python.exe smoke.py
"""

import json
import os
import time

os.environ.setdefault("USE_TF", "0")  # evita deadlock do runtime do TF no load

from laya import Router  # noqa: E402

QUESTIONS = {
    "department": {
        "type": "choice",
        "instructions": "Which department should handle this?",
        "criteria": {
            "billing": "invoices, payments, refunds",
            "technical": "bugs, outages, system errors",
            "other": "everything else",
        },
    },
    "urgency": {
        "type": "score",
        "instructions": "How urgent is this?",
        "criteria": ["not urgent", "soon", "blocking"],
    },
    "churn_risk": {
        "type": "noul",
        "instructions": "Does the user threaten to cancel or leave?",
    },
}

STATES = {
    "EN": "We were billed twice for March. Please refund the duplicate today or we will cancel our plan.",
    "PT": "Fomos cobrados duas vezes na fatura de março. Por favor, reembolse a duplicata hoje ou cancelaremos nosso plano.",
}

print("carregando Router (baixa os pesos na primeira vez)...")
t0 = time.perf_counter()
router = Router()
load_ms = (time.perf_counter() - t0) * 1000
print(f"Router pronto em {load_ms:.0f} ms")

for label, state in STATES.items():
    t0 = time.perf_counter()
    result = router.predict(state, QUESTIONS)
    dt = (time.perf_counter() - t0) * 1000
    routing = result.get("routing", {})
    print(f"[{label}] {dt:.0f} ms | routing={routing}")
    print(json.dumps(result["answers"], ensure_ascii=False, indent=2))

# segunda passada (modelo já carregado) para medir latência "quente" em PT
for _ in range(3):
    t0 = time.perf_counter()
    router.predict(STATES["PT"], QUESTIONS)
    print(f"[PT quente] {(time.perf_counter() - t0) * 1000:.0f} ms")
