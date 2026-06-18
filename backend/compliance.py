"""
Risk & Compliance engine — ISO 31000-aligned risk scoring for the platform,
inspired by @windyroad/risk-scorer (commit/push gates, secret-leak detection,
outbound comms review).

Risk is scored as likelihood × consequence (1–5 each) per category; the overall
score is the highest category risk (1–25), mapped to Low/Medium/High/Critical.
A configurable threshold decides proceed vs block. Detected secret leaks force a
Critical security score. Assessments are written to the risk register.
"""
from __future__ import annotations

import json
import logging
import re
import uuid

from . import database
from . import runtime_settings

logger = logging.getLogger(__name__)

CATEGORIES = [
    "security", "data_privacy", "financial",
    "legal_compliance", "reputational", "operational",
]

DEFAULT_THRESHOLD = 10  # block at "High" (score >= 10) by default

# Each scale level carries a definition (not just a label) so scoring is
# consistent and auditable — what does "Likely" or "Major" actually mean here.
DEFAULT_LIKELIHOOD = [
    {"label": "Rare", "definition": "May occur only in exceptional circumstances; strong controls make occurrence very unlikely."},
    {"label": "Unlikely", "definition": "Could occur, but existing controls (reviews, tests, gates) significantly reduce the probability."},
    {"label": "Possible", "definition": "Might occur under normal conditions; moderate complexity or limited controls."},
    {"label": "Likely", "definition": "Will probably occur in most circumstances without intervention; weak or missing controls."},
    {"label": "Almost certain", "definition": "Expected to occur; a known gap, no controls, or a previously observed failure mode."},
]
DEFAULT_CONSEQUENCE = [
    {"label": "Insignificant", "definition": "Negligible effect; no harm to data, finances, customers, reputation, or compliance."},
    {"label": "Minor", "definition": "Small, easily remediated effect; internal only, no external/customer impact."},
    {"label": "Moderate", "definition": "Noticeable impact; some customer/operational disruption or limited data/financial exposure."},
    {"label": "Major", "definition": "Significant impact; material financial loss, a regulatory breach, or real customer/data harm."},
    {"label": "Severe", "definition": "Critical impact; major breach, legal/regulatory action, large financial loss, or serious reputational damage."},
]

# The organisation's risk policy — editable in the app, consumed by every
# assessment so the agent scores against the company's actual specification.
DEFAULT_POLICY = {
    "threshold": DEFAULT_THRESHOLD,
    "appetite": (
        "We operate with a low appetite for security, data-privacy and legal/compliance "
        "risk, and a moderate appetite for operational and reputational risk. Never expose "
        "secrets, credentials, or personal data. Escalate anything legally or financially material."
    ),
    "categories": list(CATEGORIES),
    "likelihood_scale": [dict(x) for x in DEFAULT_LIKELIHOOD],
    "consequence_scale": [dict(x) for x in DEFAULT_CONSEQUENCE],
}


def _norm_scale(items, defaults) -> list[dict]:
    """Coerce a scale to exactly 5 {label, definition} levels, accepting the legacy
    plain-string format and back-filling definitions from the defaults."""
    items = items or []
    out = []
    for i in range(5):
        d = defaults[i]
        v = items[i] if i < len(items) else None
        if isinstance(v, dict):
            out.append({"label": str(v.get("label") or d["label"])[:60],
                        "definition": str(v.get("definition") or d["definition"])[:400]})
        elif isinstance(v, str) and v.strip():
            out.append({"label": v.strip()[:60], "definition": d["definition"]})
        else:
            out.append(dict(d))
    return out


def get_policy() -> dict:
    """Full risk policy with any saved overrides merged onto the defaults."""
    saved = {}
    try:
        saved = runtime_settings.get().get("risk_policy") or {}
        if isinstance(saved, str):
            saved = json.loads(saved)
    except Exception:
        saved = {}
    policy = {**DEFAULT_POLICY, **(saved if isinstance(saved, dict) else {})}
    policy["likelihood_scale"] = _norm_scale(policy.get("likelihood_scale"), DEFAULT_LIKELIHOOD)
    policy["consequence_scale"] = _norm_scale(policy.get("consequence_scale"), DEFAULT_CONSEQUENCE)
    # Legacy: a standalone risk_threshold still wins if no policy threshold saved.
    if "threshold" not in saved:
        try:
            policy["threshold"] = int(runtime_settings.get().get("risk_threshold", policy["threshold"]))
        except Exception:
            pass
    return policy


def get_threshold() -> int:
    try:
        return int(get_policy().get("threshold", DEFAULT_THRESHOLD))
    except Exception:
        return DEFAULT_THRESHOLD


def level_for(score: int) -> str:
    if score >= 16:
        return "critical"
    if score >= 10:
        return "high"
    if score >= 5:
        return "medium"
    return "low"


# ── Secret-leak detection ─────────────────────────────────────────────────────

_SECRET_PATTERNS = [
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("AWS secret key", re.compile(r"\baws_secret_access_key\b\s*[=:]\s*['\"]?[A-Za-z0-9/+]{40}")),
    ("GitHub token", re.compile(r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b")),
    ("Stripe live key", re.compile(r"\bsk_live_[A-Za-z0-9]{16,}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z\-_]{35}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("OpenAI/Anthropic key", re.compile(r"\bsk-(ant-)?[A-Za-z0-9-_]{20,}\b")),
    ("Private key block", re.compile(r"-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
    ("Generic secret assignment", re.compile(
        r"(?i)\b(api[_-]?key|secret|password|passwd|token|access[_-]?key)\b\s*[=:]\s*['\"][^'\"\s]{8,}['\"]")),
    ("Credit card number", re.compile(r"\b(?:\d[ -]*?){13,16}\b")),
]


def scan_secrets(text: str) -> list[dict]:
    """Detect leaked secrets / sensitive data. Returns redacted findings."""
    out = []
    seen = set()
    for label, pat in _SECRET_PATTERNS:
        for m in pat.finditer(text or ""):
            raw = m.group(0)
            if label == "Credit card number" and not _luhn(re.sub(r"\D", "", raw)):
                continue
            key = (label, raw[:6])
            if key in seen:
                continue
            seen.add(key)
            out.append({"type": label, "preview": _redact(raw)})
            if len(out) >= 20:
                return out
    return out


def _redact(s: str) -> str:
    s = s.strip()
    return s[:4] + "…" + s[-2:] if len(s) > 10 else "****"


def _luhn(num: str) -> bool:
    if not (13 <= len(num) <= 19):
        return False
    total, alt = 0, False
    for d in reversed(num):
        n = ord(d) - 48
        if alt:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        alt = not alt
    return total % 10 == 0


# ── Scoring ───────────────────────────────────────────────────────────────────

def score_categories(categories: dict) -> tuple[int, dict]:
    """Overall score = highest category likelihood×consequence (ISO 31000)."""
    norm = {}
    best = 0
    for cat, vals in (categories or {}).items():
        try:
            lk = max(1, min(5, int(vals.get("likelihood", 1))))
            cq = max(1, min(5, int(vals.get("consequence", 1))))
        except Exception:
            lk, cq = 1, 1
        s = lk * cq
        norm[cat] = {"likelihood": lk, "consequence": cq, "score": s,
                     "note": str(vals.get("note", ""))[:200]}
        best = max(best, s)
    return best, norm


def _parse_json(text: str):
    t = (text or "").strip()
    t = re.sub(r"^```(?:json)?\s*", "", t).rstrip("`").strip()
    m = re.search(r"(\{.*\}|\[.*\])", t, re.S)
    if m:
        t = m.group(1)
    return json.loads(t)


# ── LLM-assisted assessment (used by the gate and the skill) ──────────────────

async def assess(rc_agent, subject: str, content: str, *, task_id: str = "",
                 attempt: int = 0, named_policy: dict | None = None) -> dict:
    """Have the Risk & Compliance agent score `content` against ISO 31000. If a
    named policy applies, its body is the appetite and its threshold is used;
    otherwise the org baseline policy applies. Logs to the register."""
    findings = scan_secrets(content or "")
    base = get_policy()
    appetite = (named_policy.get("body") if named_policy else base.get("appetite", "")) or base.get("appetite", "")
    threshold = int(named_policy["threshold"]) if named_policy else get_threshold()
    policy_label = named_policy["name"] if named_policy else "the organisation baseline policy"

    categories = {}
    rationale = ""
    if rc_agent is not None:
        try:
            adapter = rc_agent._adapter
            model = rc_agent.config.llm_model
            cats = base.get("categories") or CATEGORIES
            lscale = base.get("likelihood_scale") or DEFAULT_LIKELIHOOD
            cscale = base.get("consequence_scale") or DEFAULT_CONSEQUENCE
            scale_txt = (
                "LIKELIHOOD levels (score 1-5):\n" +
                "\n".join(f"  {i+1} = {s['label']}: {s['definition']}" for i, s in enumerate(lscale)) +
                "\nCONSEQUENCE levels (score 1-5):\n" +
                "\n".join(f"  {i+1} = {s['label']}: {s['definition']}" for i, s in enumerate(cscale)))
            system = (
                "You are an ISO 31000 risk & compliance assessor for this organisation. Score the work "
                f"against the POLICY below ({policy_label}), across these categories: {', '.join(cats)}.\n\n"
                f"POLICY:\n{appetite}\n\n"
                f"SCORING SCALE: {scale_txt}\n\n"
                "For each relevant category give likelihood (1-5) and consequence (1-5) and a one-line note. "
                "Be conservative against the policy — flag data leakage, PII, financial/legal exposure, and "
                "reputational risk. Return ONLY JSON: {\"categories\": {\"<cat>\": {\"likelihood\": n, "
                "\"consequence\": n, \"note\": \"...\"}}, \"rationale\": \"2-3 sentences referencing the policy\"}."
            )
            user = f"Subject: {subject}\n\nWork to assess:\n\"\"\"\n{(content or '')[:6000]}\n\"\"\""
            resp = await adapter.complete(system_prompt=system,
                                          messages=[{"role": "user", "content": user}],
                                          model=model, max_tokens=900)
            data = _parse_json(resp.content)
            categories = data.get("categories", {})
            rationale = str(data.get("rationale", ""))[:1500]
        except Exception as e:
            logger.warning("[compliance] LLM assessment failed: %s", e)

    return await finalize(subject, categories, content, findings=findings,
                          rationale=rationale, task_id=task_id, attempt=attempt, threshold=threshold,
                          assessor_id=rc_agent.config.id if rc_agent is not None else "")


async def finalize(subject: str, categories: dict, content: str = "", *,
                   findings: list | None = None, rationale: str = "",
                   task_id: str = "", assessor_id: str = "", attempt: int = 0,
                   threshold: int | None = None) -> dict:
    """Compute the score/level/verdict from categories (+ secret scan) against the
    threshold, log to the register, and return the structured assessment."""
    if threshold is None:
        threshold = get_threshold()
    if findings is None:
        findings = scan_secrets(content or "")
    score, norm = score_categories(categories)

    # A detected secret leak is always Critical for security.
    if findings:
        norm["security"] = {"likelihood": 5, "consequence": 5, "score": 25,
                            "note": f"{len(findings)} secret/sensitive value(s) detected"}
        score = 25
        if not rationale:
            rationale = "Sensitive secrets/credentials detected in the output."

    level = level_for(score)
    verdict = "proceed" if score < threshold else "block"
    record = {
        "id": uuid.uuid4().hex,
        "task_id": task_id or None,
        "assessor_id": assessor_id,
        "subject": subject,
        "score": score,
        "level": level,
        "threshold": threshold,
        "verdict": verdict,
        "decision": "proceed" if verdict == "proceed" else ("held" if attempt >= 1 else "review"),
        "categories": norm,
        "findings": findings,
        "rationale": rationale,
        "attempt": attempt,
    }
    try:
        await database.save_risk_assessment(record)
    except Exception as e:
        logger.error("[compliance] could not save assessment: %s", e)
    return record


# ── Compliance mode + named policies ──────────────────────────────────────────

def get_mode() -> str:
    """How strict the compliance gate is: 'all', 'match', or 'off'."""
    m = (runtime_settings.get().get("compliance_mode") or "all").lower()
    return m if m in ("all", "match", "off") else "all"


async def summarise_policy(agent, name: str, body: str) -> str:
    """One-line summary of a policy so tasks can be matched against it."""
    if agent is None or not (body or "").strip():
        return ""
    try:
        system = ("Summarise this risk & compliance policy in ONE sentence that captures the kind of "
                  "work, topics, or actions it governs (so tasks can be matched against it). "
                  "Return only the sentence.")
        resp = await agent._adapter.complete(
            system_prompt=system,
            messages=[{"role": "user", "content": f"Policy '{name}':\n{(body or '')[:4000]}"}],
            model=agent.config.llm_model, max_tokens=120)
        return (resp.content or "").strip().strip('"')[:400]
    except Exception as e:
        logger.warning("[compliance] policy summarise failed: %s", e)
        return ""


async def match_policies(manager_agent, task_text: str, policies: list[dict]) -> list[dict]:
    """Which enabled policies relate to this task (the Manager's judgement)."""
    pols = [p for p in policies if p.get("enabled", 1)]
    if not pols or manager_agent is None:
        return []
    listing = "\n".join(
        f'- id={p["id"]} | {p.get("name","")}: {p.get("summary") or (p.get("body","")[:160])}'
        for p in pols)
    try:
        system = ("Decide which compliance policies (if any) a task relates to. Return ONLY a JSON "
                  "array of the matching policy id strings — empty array if none apply.")
        user = f"Task:\n{(task_text or '')[:1500]}\n\nPolicies:\n{listing}"
        resp = await manager_agent._adapter.complete(
            system_prompt=system, messages=[{"role": "user", "content": user}],
            model=manager_agent.config.llm_model, max_tokens=200)
        ids = _parse_json(resp.content)
        if isinstance(ids, list):
            idset = {str(x) for x in ids}
            return [p for p in pols if p["id"] in idset]
    except Exception as e:
        logger.warning("[compliance] policy match failed: %s", e)
    return []


def find_rc_agent(orchestrator):
    """The org's Risk & Compliance agent — any non-CEO agent with the risk skill."""
    from .skills.registry import RISK_TOOLS
    for a in orchestrator.get_agents():
        if a.config.is_ceo:
            continue
        if any(t in (a.config.skills or []) for t in RISK_TOOLS):
            return a
    return None
