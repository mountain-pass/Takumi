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
    "likelihood_scale": ["Rare", "Unlikely", "Possible", "Likely", "Almost certain"],
    "consequence_scale": ["Insignificant", "Minor", "Moderate", "Major", "Severe"],
}


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
    m = re.search(r"(\{.*\})", t, re.S)
    if m:
        t = m.group(1)
    return json.loads(t)


# ── LLM-assisted assessment (used by the gate and the skill) ──────────────────

async def assess(rc_agent, subject: str, content: str, *, task_id: str = "",
                 attempt: int = 0) -> dict:
    """Have the Risk & Compliance agent score `content` against ISO 31000 and the
    org threshold, factoring in detected secret leaks. Logs to the register."""
    findings = scan_secrets(content or "")
    threshold = get_threshold()

    categories = {}
    rationale = ""
    if rc_agent is not None:
        try:
            policy = get_policy()
            adapter = rc_agent._adapter
            model = rc_agent.config.llm_model
            cats = policy.get("categories") or CATEGORIES
            lscale = policy.get("likelihood_scale") or DEFAULT_POLICY["likelihood_scale"]
            cscale = policy.get("consequence_scale") or DEFAULT_POLICY["consequence_scale"]
            scale_txt = ("Likelihood 1-5 = " + ", ".join(f"{i+1} {v}" for i, v in enumerate(lscale)) +
                         ". Consequence 1-5 = " + ", ".join(f"{i+1} {v}" for i, v in enumerate(cscale)) + ".")
            system = (
                "You are an ISO 31000 risk & compliance assessor for this organisation. Score the work "
                f"against the ORGANISATION RISK POLICY below, across these categories: {', '.join(cats)}.\n\n"
                f"ORGANISATION RISK APPETITE / POLICY:\n{policy.get('appetite','')}\n\n"
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
                          rationale=rationale, task_id=task_id, attempt=attempt,
                          assessor_id=rc_agent.config.id if rc_agent is not None else "")


async def finalize(subject: str, categories: dict, content: str = "", *,
                   findings: list | None = None, rationale: str = "",
                   task_id: str = "", assessor_id: str = "", attempt: int = 0) -> dict:
    """Compute the score/level/verdict from categories (+ secret scan) against the
    threshold, log to the register, and return the structured assessment."""
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


def find_rc_agent(orchestrator):
    """The org's Risk & Compliance agent — any non-CEO agent with the risk skill."""
    from .skills.registry import RISK_TOOLS
    for a in orchestrator.get_agents():
        if a.config.is_ceo:
            continue
        if any(t in (a.config.skills or []) for t in RISK_TOOLS):
            return a
    return None
