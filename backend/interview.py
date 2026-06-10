"""
Agent interview wizard. The org's Manager generates role-specific interview
questions, candidate models (via OpenRouter) answer them while role-playing the
agent's system prompt, and the Manager evaluates which model best fits the role.

Each candidate is interviewed in a single bounded call (all questions at once,
capped max_tokens) so cost stays far under the per-model budget.
"""
from __future__ import annotations

import json
import logging
import re

import httpx

from . import database

logger = logging.getLogger(__name__)

OPENROUTER_DEFAULT_BASE = "https://openrouter.ai/api/v1"

# Curated "top" models across providers (frontier + popular open-weight). Only
# those actually present in the live OpenRouter catalogue are shown.
CURATED_MODEL_IDS = [
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-opus-4.1",
    "openai/gpt-5",
    "openai/gpt-4o-mini",
    "google/gemini-2.5-pro",
    "google/gemini-2.5-flash",
    "x-ai/grok-4",
    "deepseek/deepseek-chat",
    "meta-llama/llama-3.3-70b-instruct",
    "qwen/qwen-2.5-72b-instruct",
    "mistralai/mistral-large",
    "moonshotai/kimi-k2",
]


# ── OpenRouter provider / models ──────────────────────────────────────────────

async def get_openrouter_provider() -> dict | None:
    for p in await database.get_all_api_providers():
        if (p.get("provider") or "").lower() == "openrouter" and p.get("type") == "llm":
            return p
    return None


def _normalise_model(m: dict) -> dict:
    pricing = m.get("pricing") or {}
    arch = m.get("architecture") or {}
    in_mods = arch.get("input_modalities") or ([arch.get("modality", "")] if arch.get("modality") else [])
    params = m.get("supported_parameters") or []
    mid = m.get("id", "")
    return {
        "id": mid,
        "name": m.get("name", mid),
        "provider": mid.split("/")[0] if "/" in mid else "",
        "prompt_price": float(pricing.get("prompt", 0) or 0),       # $/token
        "completion_price": float(pricing.get("completion", 0) or 0),
        "context": m.get("context_length", 0) or 0,
        "vision": "image" in in_mods,
        "tools": "tools" in params,
        "description": (m.get("description") or "")[:200],
    }


async def list_models(api_key: str, base_url: str = OPENROUTER_DEFAULT_BASE) -> list[dict]:
    base = (base_url or OPENROUTER_DEFAULT_BASE).rstrip("/")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(base + "/models", headers=headers)
        r.raise_for_status()
        data = r.json().get("data", [])
    return [_normalise_model(m) for m in data if m.get("id")]


# ── Question generation (Manager) ─────────────────────────────────────────────

def _ceo_adapter(orchestrator):
    ceo = getattr(orchestrator, "_ceo", None)
    if not ceo:
        raise ValueError("Manager agent is not available")
    return ceo._adapter, ceo.config.llm_model


def _parse_json(text: str):
    t = (text or "").strip()
    t = re.sub(r"^```(?:json)?\s*", "", t).rstrip("`").strip()
    # Grab the first {...} or [...] block.
    m = re.search(r"(\{.*\}|\[.*\])", t, re.S)
    if m:
        t = m.group(1)
    return json.loads(t)


async def generate_questions(orchestrator, role: str, description: str,
                             system_prompt: str, constraints: dict) -> list[str]:
    adapter, model = _ceo_adapter(orchestrator)
    # Capability priorities, each with a concrete example of the kind of task the
    # question should put the model in.
    cap_map = {
        "needs_tools": "calling tools/APIs to take real actions (e.g. publishing a LinkedIn post, creating a ticket, querying a database)",
        "needs_browser": "browsing/searching the web for current information (e.g. researching breaking industry news)",
        "needs_vision": "interpreting images it is given (e.g. reading a chart or screenshot)",
        "needs_image": "generating images (e.g. producing a social graphic or thumbnail)",
        "max_cost": "working efficiently and concisely to keep token cost low",
    }
    caps = [cap_map[k] for k in cap_map if constraints.get(k)]
    caps_text = ("; ".join(caps)) if caps else "the core skills this role requires"
    system = (
        "You are the Manager of an AI organisation hiring an AI MODEL for a specialist role. "
        "Write probing, SCENARIO-BASED interview questions that test HOW THIS MODEL would actually "
        "DO this job day-to-day — grounded in the role, its description, and its system prompt. "
        "Each question should drop the model into a concrete, realistic situation from THIS role and "
        "reveal its approach, reasoning, and use of its capabilities — e.g. exactly how it would call a "
        "tool to perform an action, how it would browse/search to gather information, how it would handle "
        "an image, or how it would generate one. Prefer 'show me how you would …' scenarios over abstract "
        "trivia. Make the questions specific to the role's real tasks, not generic. "
        "Return ONLY a JSON array of 5-10 question strings."
    )
    user = (
        f"Role: {role}\n"
        f"Description: {description}\n"
        f"The agent's system prompt (its actual job/persona):\n\"\"\"\n{system_prompt}\n\"\"\"\n\n"
        f"Capabilities/priorities this hire must prove: {caps_text}.\n\n"
        "Write 5-10 scenario-based questions tied to the real tasks of this role and its system prompt. "
        "At least a few must explicitly probe the prioritised capabilities above (e.g. the exact tool call "
        "or search workflow the model would use). Return a JSON array of strings only."
    )
    # Retry once — the Manager's model can return an empty completion.
    content = ""
    for _ in range(2):
        resp = await adapter.complete(system_prompt=system,
                                      messages=[{"role": "user", "content": user}],
                                      model=model, max_tokens=2000)
        content = (resp.content or "").strip()
        if content:
            break
    qs = _extract_questions(content)
    if len(qs) >= 3:
        return qs[:10]
    logger.warning("[interview] question extraction weak (%d) | raw=%r", len(qs), content[:200])
    return _fallback_questions(role, constraints)


def _extract_questions(text: str) -> list[str]:
    """Pull questions out of the model's reply — JSON array if valid, otherwise
    salvage the complete quoted strings (robust to truncation), then numbered lines."""
    if not text:
        return []
    try:
        arr = _parse_json(text)
        if isinstance(arr, list):
            out = [str(q).strip() for q in arr if str(q).strip()]
            if out:
                return out
    except Exception:
        pass
    # Salvage: every complete double-quoted string (handles truncated JSON tails).
    quoted = re.findall(r'"((?:[^"\\]|\\.)+?)"', text)
    quoted = [q.replace('\\"', '"').replace("\\n", " ").strip() for q in quoted]
    quoted = [q for q in quoted if len(q) > 15 and "?" in q or len(q) > 30]
    if len(quoted) >= 3:
        return quoted
    # Numbered / bulleted lines.
    lines = re.findall(r'(?m)^\s*(?:\d+[.)]|[-*])\s+(.+)$', text)
    return [l.strip().strip('",') for l in lines if len(l.strip()) > 15]


def _fallback_questions(role: str, constraints: dict | None = None) -> list[str]:
    c = constraints or {}
    qs = [
        f"Walk me through, step by step, how you would carry out a typical task for a {role} — what you'd do first, what you'd produce, and how you'd check it.",
        f"Give a concrete example of a {role} request and show exactly how you'd handle it end to end.",
        "When a request is ambiguous, how do you decide what to do, and what would you ask or assume?",
    ]
    if c.get("needs_tools"):
        qs.append(f"Show me precisely how you'd call a tool/API to complete an action for this role (e.g. publishing a post or updating a record) — what tool, what arguments, and how you'd confirm it worked.")
    if c.get("needs_browser"):
        qs.append("Describe your exact web-search/browsing workflow to gather current, accurate information for this role — the queries you'd run and how you'd verify sources.")
    if c.get("needs_vision"):
        qs.append("You're given an image relevant to this role. How would you interpret it and turn it into useful output?")
    if c.get("needs_image"):
        qs.append("How would you generate an on-brief image for this role, and how would you describe/prompt it?")
    if c.get("max_cost"):
        qs.append("How do you keep responses efficient and concise without losing quality?")
    qs.append("Describe a tricky edge case in this domain and how you'd handle it.")
    return qs[:10]


# ── Run interviews + evaluate ─────────────────────────────────────────────────

async def interview_model(base_url: str, api_key: str, model_id: str,
                          system_prompt: str, questions: list[str],
                          max_cost: float = 1.0) -> dict:
    """Ask one candidate model all the questions in a single bounded call."""
    base = (base_url or OPENROUTER_DEFAULT_BASE).rstrip("/")
    q_block = "\n".join(f"{i+1}. {q}" for i, q in enumerate(questions))
    user = ("You are interviewing for a role. Answer each question concisely and "
            "concretely (a few sentences each), numbered to match.\n\n" + q_block)
    body = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": system_prompt or "You are a capable specialist agent."},
            {"role": "user", "content": user},
        ],
        "max_tokens": 900,
        "usage": {"include": True},
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json",
               "HTTP-Referer": "https://takumi.local", "X-Title": "Takumi Interview"}
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(base + "/chat/completions", headers=headers, json=body)
        if r.status_code >= 400:
            return {"model_id": model_id, "error": f"HTTP {r.status_code}: {r.text[:200]}", "answer": "", "cost": 0}
        data = r.json()
        answer = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
        usage = data.get("usage") or {}
        cost = float(usage.get("cost", 0) or 0)
        return {"model_id": model_id, "answer": answer, "cost": round(cost, 4),
                "tokens": usage.get("total_tokens", 0),
                "over_budget": cost > max_cost}
    except Exception as e:
        return {"model_id": model_id, "error": str(e)[:200], "answer": "", "cost": 0}


async def evaluate(orchestrator, role: str, description: str, constraints: dict,
                   transcripts: list[dict]) -> dict:
    adapter, model = _ceo_adapter(orchestrator)
    valid = [t for t in transcripts if t.get("answer")]
    if not valid:
        return {"recommended": None, "summary": "No candidate produced a usable answer.", "ranking": []}
    blocks = []
    for t in valid:
        blocks.append(f"### Candidate: {t['model_id']} (interview cost ${t.get('cost',0)})\n{t['answer'][:2500]}")
    cons = {k: v for k, v in constraints.items() if v}
    system = (
        "You are the Manager evaluating candidate models for a role based on their interview answers. "
        "Weigh quality, relevance, reasoning, and the stated priorities (including cost). "
        "Return ONLY JSON: {\"recommended\": \"<model_id>\", \"summary\": \"<2-3 sentences>\", "
        "\"ranking\": [{\"model_id\": \"...\", \"score\": <0-100>, \"verdict\": \"<one line>\"}]}."
    )
    ids = [t["model_id"] for t in valid]
    user = (f"Role: {role}\nDescription: {description}\nPriorities: {json.dumps(cons)}\n\n"
            "Candidate interviews:\n\n" + "\n\n".join(blocks) +
            f"\n\nThe candidate model_ids are: {ids}. "
            "Pick the single best-fit model and rank them all. Use the exact model_ids above.")
    content = ""
    for _ in range(2):
        resp = await adapter.complete(system_prompt=system,
                                      messages=[{"role": "user", "content": user}],
                                      model=model, max_tokens=2200)
        content = (resp.content or "").strip()
        if content:
            break
    out = _extract_evaluation(content, ids)
    if out:
        return out
    logger.warning("[interview] eval parse failed | raw=%r", content[:250])
    best = max(valid, key=lambda t: len(t.get("answer", "")))
    return {"recommended": best["model_id"],
            "summary": "Picked the most thorough answer (the Manager's structured verdict was unavailable).",
            "ranking": [{"model_id": t["model_id"], "score": 0, "verdict": ""} for t in valid]}


def _match_id(raw: str, ids: list[str]) -> str:
    """Map a possibly-shortened model id back to a real candidate id."""
    raw = (raw or "").strip()
    if raw in ids:
        return raw
    for mid in ids:
        if raw and (raw in mid or mid in raw or raw.split("/")[-1] == mid.split("/")[-1]):
            return mid
    return raw


def _extract_evaluation(text: str, ids: list[str]) -> dict | None:
    """Parse the Manager's verdict — strict JSON first, then salvage from partial/
    truncated output (recommended id + per-model score/verdict)."""
    if not text:
        return None
    # 1. Strict JSON.
    try:
        out = _parse_json(text)
        if isinstance(out, dict) and (out.get("recommended") or out.get("ranking")):
            ranking = out.get("ranking") or []
            for r in ranking:
                r["model_id"] = _match_id(r.get("model_id", ""), ids)
            rec = _match_id(out.get("recommended") or (ranking[0]["model_id"] if ranking else ""), ids)
            return {"recommended": rec, "summary": (out.get("summary") or "").strip(), "ranking": ranking}
    except Exception:
        pass
    # 2. Salvage from partial text.
    rec_m = re.search(r'"recommended"\s*:\s*"([^"]+)"', text)
    summary_m = re.search(r'"summary"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    ranking = []
    for rm in re.finditer(r'"model_id"\s*:\s*"([^"]+)"(?:[^}]*?"score"\s*:\s*(\d+))?(?:[^}]*?"verdict"\s*:\s*"((?:[^"\\]|\\.)*)")?', text):
        ranking.append({
            "model_id": _match_id(rm.group(1), ids),
            "score": int(rm.group(2)) if rm.group(2) else 0,
            "verdict": (rm.group(3) or "").replace('\\"', '"'),
        })
    recommended = _match_id(rec_m.group(1), ids) if rec_m else (ranking[0]["model_id"] if ranking else "")
    if recommended or ranking:
        return {"recommended": recommended,
                "summary": (summary_m.group(1).replace('\\"', '"') if summary_m else ""),
                "ranking": ranking}
    return None
