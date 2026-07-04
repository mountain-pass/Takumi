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

# ── Impact table (the heart of a policy) ──────────────────────────────────────
# The likelihood scale and the 5×5 matrix are GENERIC and never change. Risk
# *appetite* is expressed entirely by the impact table: for each category, what
# counts as Insignificant…Severe. Tuning a category's thresholds down (e.g. making
# a large financial loss only "Moderate") lowers its effective appetite, so a
# single uniform block-at-score can apply to every category.
SEVERITY_LABELS = ["Insignificant", "Minor", "Moderate", "Major", "Severe"]

# Generic, appetite-neutral starting point — the interview tunes these cells.
DEFAULT_IMPACT_TABLE = [
    {"category": "financial", "definitions": [
        "Negligible cost, easily absorbed.",
        "Minor cost; no effect on viability.",
        "Noticeable loss, recoverable in normal operations.",
        "Material loss affecting the viability of the activity.",
        "Catastrophic loss; threatens the whole organisation."]},
    {"category": "data_privacy", "definitions": [
        "No personal or sensitive data involved.",
        "Internal data only; no external exposure.",
        "Limited personal-data exposure, contained.",
        "Significant personal-data exposure or loss.",
        "Large-scale breach of sensitive personal data."]},
    {"category": "security", "definitions": [
        "No security relevance.",
        "Low-risk, well-contained exposure.",
        "Exploitable weakness with limited blast radius.",
        "Serious vulnerability; sensitive systems at risk.",
        "Critical compromise; secrets or keys exposed."]},
    {"category": "legal_compliance", "definitions": [
        "Fully compliant; no legal exposure.",
        "Minor process deviation; no breach.",
        "Technical breach; low regulatory interest.",
        "Clear regulatory breach; penalties likely.",
        "Serious breach; enforcement action or litigation."]},
    {"category": "reputational", "definitions": [
        "No visibility.",
        "Internal awareness only.",
        "Limited external notice; quickly forgotten.",
        "Sustained negative coverage or customer loss.",
        "Widespread coverage; lasting brand damage."]},
    {"category": "operational", "definitions": [
        "No disruption.",
        "Brief, self-correcting disruption.",
        "Noticeable disruption; manual workaround needed.",
        "Major disruption; core activity halted for a time.",
        "Sustained outage; unable to operate."]},
]


def _norm_impact_table(items) -> list[dict]:
    """Coerce an impact table to one row per category, each with 5 cell definitions."""
    by_cat = {}
    for row in (items or []):
        if isinstance(row, dict) and row.get("category"):
            by_cat[str(row["category"])] = row.get("definitions") or []
        elif isinstance(row, dict):  # tolerate {category_key: [..]} style
            for k, v in row.items():
                by_cat[str(k)] = v
    out = []
    for d in DEFAULT_IMPACT_TABLE:
        cat = d["category"]
        defs = by_cat.get(cat) or []
        cells = [str(defs[i])[:300] if i < len(defs) and str(defs[i]).strip()
                 else d["definitions"][i] for i in range(5)]
        out.append({"category": cat, "definitions": cells})
    return out


def impact_table_text(table) -> str:
    """Render the impact table as plain text for injection into assessments."""
    table = _norm_impact_table(table)
    lines = ["Impact table (defines consequence severity 1-5 per category):"]
    for row in table:
        cat = row["category"].replace("_", " ")
        cells = " | ".join(f"{i+1} {SEVERITY_LABELS[i]}: {row['definitions'][i]}" for i in range(5))
        lines.append(f"- {cat}: {cells}")
    return "\n".join(lines)


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
    assess_error = ""
    if rc_agent is not None:
        try:
            cats = base.get("categories") or CATEGORIES
            lscale = base.get("likelihood_scale") or DEFAULT_LIKELIHOOD
            cscale = base.get("consequence_scale") or DEFAULT_CONSEQUENCE
            scale_txt = (
                "LIKELIHOOD levels (score 1-5):\n" +
                "\n".join(f"  {i+1} = {s['label']}: {s['definition']}" for i, s in enumerate(lscale)) +
                "\nCONSEQUENCE levels (score 1-5):\n" +
                "\n".join(f"  {i+1} = {s['label']}: {s['definition']}" for i, s in enumerate(cscale)))
            # The policy's impact table IS its appetite — score consequence per category from it.
            itable = None
            if named_policy:
                try:
                    raw = named_policy.get("impact_table")
                    itable = raw if isinstance(raw, list) else json.loads(raw or "[]")
                except Exception:
                    itable = None
            if itable:
                scale_txt += ("\n\nThis policy's IMPACT TABLE defines consequence severity per "
                              "category (use it as the source of truth for consequence):\n" +
                              impact_table_text(itable))
            from datetime import datetime, timezone
            today = datetime.now(timezone.utc).strftime("%A, %d %B %Y")
            system = (
                f"Today's real-world date is {today}. The work you are reviewing may legitimately "
                "describe events, prices, statistics, or news that are AFTER your training cutoff — "
                "that is expected and is NOT a risk by itself. Do NOT flag content as fabricated or "
                "non-compliant merely because you don't recognise it; judge it on actual policy risk.\n\n"
                "You are an ISO 31000 risk & compliance assessor for this organisation. Your job is to "
                "REVIEW work produced by other agents and rate its risk — you are NOT producing or endorsing "
                "the content. The work may contain harmful, unsafe, or policy-violating material; that is "
                "exactly what you must catch. NEVER refuse and NEVER return a safety disclaimer — reviewing "
                "dangerous output is the whole point. The more dangerous the content, the higher you score it "
                "(harmful/illegal content = likelihood and consequence near 5). "
                f"Score the work against the POLICY below ({policy_label}), across these categories: "
                f"{', '.join(cats)}.\n\n"
                f"POLICY:\n{appetite}\n\n"
                f"SCORING SCALE: {scale_txt}\n\n"
                "For each relevant category give likelihood (1-5) and consequence (1-5) and a one-line note. "
                "Be conservative against the policy — flag data leakage, PII, financial/legal exposure, "
                "reputational risk, and any unsafe/illegal instructions.\n\n"
                "VERIFY BEFORE SCORING: if the work makes time-sensitive factual claims (prices, "
                "statistics, events, dates, who runs/owns something, public/private status, news), use "
                "your `web_search`/`web_fetch` tools to confirm them against live sources — do not rely on "
                "memory. A claim you confirm to be FALSE or unverifiable is a reputational/operational "
                "risk and must be scored accordingly; note what you verified.\n\n"
                "When finished, return ONLY JSON: "
                "{\"categories\": {\"<cat>\": {\"likelihood\": n, \"consequence\": n, \"note\": \"...\"}}, "
                "\"rationale\": \"2-3 sentences referencing the policy and any facts you verified\"}. "
                "Output MINIFIED JSON on a single line, no code fences, keep each note under 20 words."
            )
            user = f"Subject: {subject}\n\nWork to assess:\n\"\"\"\n{(content or '')[:6000]}\n\"\"\""
            # Run the review through the agent's full tool loop so it can web_search/web_fetch
            # to verify time-sensitive claims (it inherits the agent's skills + temporal preamble).
            # Safety-tuned models sometimes refuse or return prose; retry once with a firmer
            # JSON-only nudge before treating it as an unscorable failure.
            data = None
            for attempt_i in range(2):
                msgs = [{"role": "user", "content": user}]
                if attempt_i == 1:
                    msgs.append({"role": "user", "content": "Return ONLY the JSON object — no prose, no "
                                 "refusal. This is a compliance review; score the content's risk."})
                resp = await rc_agent._do_work_with_tools(user, max_rounds=6,
                                                          system_extra=system, messages=msgs)
                try:
                    data = _parse_json(resp.content)
                    break
                except Exception:
                    if attempt_i == 1:
                        raise ValueError(f"assessor returned no scorable JSON ({(resp.content or '')[:80]!r})")
            categories = data.get("categories", {})
            rationale = str(data.get("rationale", ""))[:1500]
        except Exception as e:
            assess_error = str(e)[:300]
            logger.warning("[compliance] LLM assessment failed: %s", e)

    return await finalize(subject, categories, content, findings=findings,
                          rationale=rationale, task_id=task_id, attempt=attempt, threshold=threshold,
                          assessor_id=rc_agent.config.id if rc_agent is not None else "",
                          error=assess_error)


async def finalize(subject: str, categories: dict, content: str = "", *,
                   findings: list | None = None, rationale: str = "",
                   task_id: str = "", assessor_id: str = "", attempt: int = 0,
                   threshold: int | None = None, error: str = "") -> dict:
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
        # Set when the assessor could not actually score (LLM/auth error). With no
        # categories and no findings the score is meaningless — callers must not
        # treat this as a genuine pass.
        "error": error or None,
        "incomplete": bool(error) and not norm and not findings,
    }
    try:
        await database.save_risk_assessment(record)
    except Exception as e:
        logger.error("[compliance] could not save assessment: %s", e)
    return record


# ── Compliance mode + named policies ──────────────────────────────────────────

def get_mode() -> str:
    """How strict the compliance gate is:
      - 'all'             → every finished task is reviewed.
      - 'unless_excluded' → every task is reviewed UNLESS the user explicitly tells
                            the Manager to exclude it (the bypass is logged for audit).
      - 'off'             → no review.
    """
    m = (runtime_settings.get().get("compliance_mode") or "all").lower()
    if m == "match":  # legacy mode → closest new semantic
        m = "unless_excluded"
    return m if m in ("all", "unless_excluded", "off") else "all"


# Phrases that signal the user explicitly wants to skip the compliance review.
_EXCLUDE_HINTS = (
    "no compliance", "skip compliance", "bypass compliance", "without compliance",
    "exclude from compliance", "no compliance review", "skip the compliance review",
    "no risk review", "skip risk review", "bypass review", "exclude from risk review",
    "without risk review", "no risk and compliance", "skip risk and compliance",
)


async def should_exclude(manager_agent, text: str) -> tuple[bool, str]:
    """In 'unless_excluded' mode, decide if the user explicitly asked to bypass the
    compliance review for this task. Heuristic first (cheap, deterministic, auditable),
    then a bounded LLM confirmation only when the wording is ambiguous."""
    low = (text or "").lower()
    for h in _EXCLUDE_HINTS:
        if h in low:
            return True, f"User explicitly requested exclusion (\"{h}\")."
    # Only spend an LLM call when the text actually talks about compliance/bypassing.
    triggers = ("complian", "risk review", "bypass", "exclude", "skip", "without review")
    if manager_agent is None or not any(t in low for t in triggers):
        return False, ""
    try:
        system = ("Does the user EXPLICITLY ask to skip, exclude, or bypass the risk & compliance "
                  "review for this task? Only 'true' if they clearly opt out — not merely because "
                  "the task seems low-risk. Return ONLY JSON {\"exclude\": true|false, \"reason\": \"...\"}.")
        resp = await manager_agent._adapter.complete(
            system_prompt=system, messages=[{"role": "user", "content": (text or "")[:1000]}],
            model=manager_agent.config.llm_model, max_tokens=120)
        data = _parse_json(resp.content)
        if isinstance(data, dict) and data.get("exclude"):
            return True, str(data.get("reason") or "User explicitly requested exclusion.")[:200]
    except Exception as e:
        logger.warning("[compliance] exclusion check failed: %s", e)
    return False, ""


async def log_audit(*, action: str, summary: str, ok: int = 1, task_id: str | None = None,
                    agent_id: str = "", agent_name: str = "Manager", kind: str = "compliance") -> None:
    """Append a compliance/governance event to the audit trail (activity_log)."""
    try:
        await database.log_activity({
            "agent_id": agent_id, "agent_name": agent_name, "kind": kind,
            "action": action, "summary": summary, "ok": int(ok), "task_id": task_id,
        })
    except Exception:
        pass  # audit logging must never break the workflow


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


_INTERVIEW_SYSTEM = (
    "You are the Manager of an AI organisation running a RISK & COMPLIANCE policy "
    "interview. The output is NOT prose — it is an IMPACT TABLE. The likelihood scale "
    "and the 5×5 matrix are GENERIC and never change; appetite is expressed ENTIRELY by "
    "the impact table: for each category, what counts as Insignificant(1)…Severe(5). "
    "Tuning a category down (e.g. a large financial loss is only 'Moderate') lowers its "
    "appetite, so ONE uniform block-at-score can apply to EVERY category.\n\n"
    "Run the interview ONE TURN AT A TIME — never advance until the user has answered.\n"
    "1) First 1-2 turns: learn what kind of organisation this is and any regulations.\n"
    "2) Then CALIBRATE with role-play SCENARIOS. Invent a concrete, realistic scenario for "
    "THIS organisation and ask whether that outcome is acceptable. Offer 3-4 options so the "
    "user just picks their view (they can also type their own). This reveals TRUE appetite, "
    "not what they think it is. Cover financial, data/privacy, legal/compliance, reputational "
    "and operational outcomes.\n"
    "3) Also ask how often the policy should be reviewed (most orgs: annually, and after "
    "any major incident).\n\n"
    "ADAPT THE DEPTH to the business — do not use a fixed number of questions:\n"
    "- Highly regulated / complex (finance, healthcare, handling client money or large PII, "
    "multiple jurisdictions): probe DEEPER. Ask sharper follow-ups and more scenarios to pin "
    "down each regulated area. Aim ~7-10 calibration turns, but never exceed 12 total.\n"
    "- Simple, low-risk, unregulated (e.g. a solo operator): ask only ENOUGH to set the impact "
    "table and threshold — roughly 3-5 calibration turns — then finish. Don't pad it out.\n"
    "Whenever you can responsibly fill the impact table and choose a block-at-score, STOP and "
    "return the final policy — do not keep asking once you have enough.\n\n"
    "Respond with STRICT JSON only, ONE of:\n"
    "- a plain question: {\"type\":\"question\",\"question\":\"<one question>\"}\n"
    "- a calibration scenario: {\"type\":\"scenario\",\"scenario\":\"<one concrete scenario>\","
    "\"options\":[\"<view A>\",\"<view B>\",\"<view C>\"]}\n"
    "- the finished policy: {\"type\":\"final\",\"name\":\"<short policy name>\","
    "\"appetite\":\"<DETAILED plain-language summary that MATCHES the impact table — keep the "
    "specifics (concrete amounts, what is acceptable vs not, the scenarios) so an agent can use it "
    "for risk decisions; fix typos/grammar but do not over-summarise>\","
    "\"impact_table\":[{\"category\":\"financial\",\"definitions\":[\"<sev1>\",\"<sev2>\",\"<sev3>\","
    "\"<sev4>\",\"<sev5>\"]}, ... one row per category: financial, data_privacy, security, "
    "legal_compliance, reputational, operational],"
    "\"threshold\":<int 1-25 block-at-score, applied uniformly. HIGHER = MORE risk-tolerant "
    "(only the most severe work is blocked); LOWER = cautious. Set it to MATCH how tolerant their "
    "answers were — a very risk-tolerant person should get a HIGH threshold (18-22), a cautious "
    "person a LOW one (5-8); 10-13 is balanced>,"
    "\"review_frequency_months\":<int — use the cadence the USER stated: quarterly=3, every 6 "
    "months=6, annually=12; do NOT default to 12 if they said otherwise>,"
    "\"rationale\":\"<why this threshold and how the impact table reflects their scenario answers>\"}\n"
    "In 'appetite', FIX all spelling, typos and grammar from the user's answers and write it cleanly "
    "and professionally — do NOT quote their raw text. Each impact cell is a short concrete definition "
    "tuned to their answers. Output JSON and nothing else."
)


# Dedicated, retried finalisation — isolating the heavy JSON from the per-turn prompt
# makes it far more reliable than asking for "next turn OR final" in one shot.
_FINALIZE_SYSTEM = (
    "You are writing a company's ISO 31000 risk policy from a COMPLETED interview. Respond with "
    "STRICT JSON only, keys: name, appetite, threshold, impact_table, review_frequency_months, "
    "rationale.\n"
    "- appetite: a clean, professional but DETAILED summary of their risk appetite. FIX every "
    "spelling mistake, typo and grammar error, but KEEP the specifics — concrete amounts, what is "
    "acceptable vs unacceptable, the scenarios they reacted to — so an agent can use it to make risk "
    "decisions later. Do not over-summarise or drop details; do NOT quote their raw words.\n"
    "- threshold: the block-at-score on the 5×5 matrix (1-25), applied uniformly. HIGHER = MORE "
    "risk-tolerant (only the most severe risks are blocked); LOWER = cautious. Choose it to MATCH "
    "their tolerance: very tolerant → 18-22, balanced → 10-13, cautious → 5-8.\n"
    "- impact_table: one row per category [financial, data_privacy, security, legal_compliance, "
    "reputational, operational], each with 5 short severity definitions (levels 1-5) tuned to them.\n"
    "- review_frequency_months: integer — use the cadence the USER stated (e.g. quarterly = 3, "
    "every 6 months = 6, annually = 12). Do NOT default to 12 if they said otherwise.\n"
    "- rationale: 1-2 sentences on why this threshold, referencing their tolerance.\n"
    "Output JSON and nothing else."
)


# Risk-tolerance signal phrases for the heuristic block-at-score (last resort only).
_TOLERANT_HINTS = (
    "acceptable", "not a concern", "not a major concern", "not a big deal", "tolerable",
    "part of doing business", "i can live with", "live with it", "wait it out", "wait out",
    "low concern", "not worried", "fine by me", "yolo", "manageable", "move on", "earn it back",
    "pay the fine", "hold the position", "not a problem",
)
_AVERSE_HINTS = (
    "never", "unacceptable", "not acceptable", "must not", "must never", "avoid at all costs",
    "zero tolerance", "prevent", "sign-off", "sign off", "explicit approval", "approval required",
    "cannot happen", "can't happen", "at all costs", "critical that",
)


def _infer_threshold(answers: list[str]) -> int:
    """Heuristic block-at-score from interview answers: more tolerant answers → higher
    threshold (block only the worst); more risk-averse → lower threshold (block sooner)."""
    tol = av = 0
    for a in answers:
        low = (a or "").lower()
        if any(h in low for h in _AVERSE_HINTS):
            av += 1
        elif any(h in low for h in _TOLERANT_HINTS):
            tol += 1
    return max(5, min(22, 10 + 3 * (tol - av)))


def _infer_review_months(answers: list[str]) -> int:
    """Pull the review cadence the user actually stated (e.g. "every 3 months",
    "quarterly", "annually") out of their answers. Defaults to 12 (annual)."""
    text = " ".join(answers).lower()
    m = re.search(r"every\s+(\d{1,2})\s*month", text) or re.search(r"(\d{1,2})\s*month", text)
    if m:
        return max(1, min(60, int(m.group(1))))
    m = re.search(r"every\s+(\d{1,2})\s*year", text)
    if m:
        return max(1, min(60, int(m.group(1)) * 12))
    if "quarter" in text:                       # quarterly
        return 3
    if "monthly" in text:
        return 1
    if "fortnight" in text or "every two weeks" in text or "biweekly" in text:
        return 1
    if "semi-annual" in text or "biannual" in text or "twice a year" in text or "every 6 months" in text:
        return 6
    if "annual" in text or "yearly" in text or "every year" in text or "once a year" in text:
        return 12
    return 12


def _cadence_phrase(months: int) -> str:
    if months == 12:
        return "annually"
    if months == 3:
        return "every 3 months (quarterly)"
    if months == 1:
        return "monthly"
    if months == 6:
        return "every 6 months"
    return f"every {months} months"


def _scripted_synthesise(history: list[dict]) -> dict:
    """Heuristic final policy when the LLM isn't available — derives the block-at-score
    AND the review cadence from the answers, and keeps the interview detail in the summary
    so the assessing agent has the specifics (amounts, what's acceptable, etc.)."""
    answers = [m.get("content", "").strip() for m in (history or []) if m.get("role") == "user"]
    answers = [a for a in answers if a]
    threshold = _infer_threshold(answers)
    review_months = _infer_review_months(answers)
    appetite_level = "high" if threshold >= 16 else "moderate" if threshold >= 10 else "low"
    detail = " ".join(a if a.endswith((".", "!", "?")) else a + "." for a in answers)
    appetite = (
        f"This organisation has a {appetite_level} appetite for risk. A single block-at-score of "
        f"{threshold} applies uniformly across every category (a higher score blocks only the most "
        f"severe work). Details from the interview to guide assessment: {detail} "
        f"The policy is reviewed {_cadence_phrase(review_months)} and after any major incident."
    )
    rationale = (
        f"Block-at-score set to {threshold} to match the {appetite_level} risk tolerance expressed in "
        f"the interview; review cadence {_cadence_phrase(review_months)}. A higher score blocks only the "
        f"most severe risks; a lower one is more cautious."
    )
    return {"type": "final", "name": "Risk Policy", "appetite": appetite, "threshold": threshold,
            "review_frequency_months": review_months,
            "impact_table": [dict(r) for r in DEFAULT_IMPACT_TABLE], "rationale": rationale}


async def _finalize_policy(manager_agent, history: list[dict]) -> dict:
    """Build the final policy from the full transcript with a dedicated, retried call.
    Falls back to the heuristic synthesis if the model can't produce valid JSON."""
    transcript = "\n".join(
        f'{"Interviewer" if m.get("role") == "assistant" else "User"}: {m.get("content", "")}'
        for m in (history or []))
    if manager_agent is not None and transcript.strip():
        for _ in range(3):
            try:
                resp = await manager_agent._adapter.complete(
                    system_prompt=_FINALIZE_SYSTEM,
                    messages=[{"role": "user", "content": transcript[:6000]}],
                    model=manager_agent.config.llm_model, max_tokens=1200)
                data = _parse_json(resp.content)
                if isinstance(data, dict) and (data.get("appetite") or data.get("impact_table")):
                    return {
                        "type": "final",
                        "name": str(data.get("name") or "Risk Policy")[:80],
                        "appetite": str(data.get("appetite") or "").strip(),
                        "threshold": max(1, min(25, int(data.get("threshold", 10) or 10))),
                        "review_frequency_months": max(1, min(60, int(data.get("review_frequency_months", 12) or 12))),
                        "impact_table": _norm_impact_table(data.get("impact_table")),
                        "rationale": str(data.get("rationale") or "").strip(),
                    }
            except Exception as e:
                logger.warning("[compliance] finalize failed: %s", e)
    return _scripted_synthesise(history)


# Scripted turns used when the Manager's LLM can't return parseable JSON, so the
# interview still progresses (and finalises) instead of repeating one turn forever.
# A turn is either a plain question or a calibration scenario with options.
_FALLBACK_TURNS = [
    {"type": "question", "question":
        "What industry does your organisation operate in, and are there any regulations or "
        "standards (e.g. GDPR, HIPAA, SOX, APRA CPS 234) you must comply with?"},
    {"type": "scenario",
     "scenario": "A single decision wipes out a large share of the capital tied to that activity. "
                 "How acceptable is that outcome?",
     "options": ["Never acceptable — must be prevented", "Acceptable only with sign-off",
                 "Acceptable — it's part of doing business"]},
    {"type": "scenario",
     "scenario": "Personal or sensitive data is exposed externally, even briefly. "
                 "How do you view that?",
     "options": ["Unacceptable under any circumstances", "Tolerable if quickly contained",
                 "Low concern for us"]},
    {"type": "scenario",
     "scenario": "An action puts you in clear breach of a regulation or the law. Your view?",
     "options": ["Must never happen", "Only with explicit human approval", "A risk we'd accept"]},
    {"type": "scenario",
     "scenario": "Something goes public and attracts sustained negative attention. How acceptable?",
     "options": ["Avoid at all costs", "Manageable if handled well", "Not a major concern"]},
    {"type": "question", "question":
        "How often should this policy be reviewed? Most orgs review annually and after any major incident."},
]


def _scripted_step(history: list[dict]) -> dict:
    """Deterministic fallback: advance through fixed turns, then synthesise a policy
    (with a generic impact table). Guarantees the interview always makes progress."""
    asked = sum(1 for m in (history or []) if m.get("role") == "assistant")
    if asked < len(_FALLBACK_TURNS):
        return dict(_FALLBACK_TURNS[asked])
    return _scripted_synthesise(history)


# Hard bounds on interview length so it adapts but can never run forever.
MAX_INTERVIEW_QUESTIONS = 12


async def policy_interview(manager_agent, history: list[dict]) -> dict:
    """Drive one turn of the policy interview. `history` is the prior Q&A
    (assistant=question, user=answer). Returns {type:'question'|'final', ...}.
    The LLM decides how many questions to ask (deeper for regulated/complex orgs,
    fewer for simple ones); this caps it at MAX_INTERVIEW_QUESTIONS regardless."""
    answered = sum(1 for m in (history or []) if m.get("role") == "user")
    if answered >= MAX_INTERVIEW_QUESTIONS:
        # Cap reached — finalise now even if the model wanted to keep going.
        return await _finalize_policy(manager_agent, history)
    if manager_agent is None:
        return _scripted_step(history)
    msgs = [{"role": ("assistant" if m.get("role") == "assistant" else "user"),
             "content": m.get("content", "")} for m in (history or [])]
    if not msgs:
        msgs = [{"role": "user", "content": "Begin the interview. Ask your first question."}]
    # The user has already answered this many questions; never re-ask one.
    asked_already = {m.get("content", "").strip()
                     for m in (history or []) if m.get("role") == "assistant"}
    last_err = None
    for attempt in range(2):  # glm-5.1 is flaky; one retry before falling back
        try:
            resp = await manager_agent._adapter.complete(
                system_prompt=_INTERVIEW_SYSTEM, messages=msgs,
                model=manager_agent.config.llm_model, max_tokens=900)
            data = _parse_json(resp.content)
            if isinstance(data, dict) and data.get("type") in ("question", "scenario", "final"):
                if data["type"] == "final":
                    data["threshold"] = max(1, min(25, int(data.get("threshold", 10) or 10)))
                    data["review_frequency_months"] = max(1, min(60, int(data.get("review_frequency_months", 12) or 12)))
                    data["impact_table"] = _norm_impact_table(data.get("impact_table"))
                    return data
                if data["type"] == "scenario":
                    sc = (data.get("scenario") or "").strip()
                    if sc and sc not in asked_already:
                        opts = [str(o).strip() for o in (data.get("options") or []) if str(o).strip()][:4]
                        return {"type": "scenario", "scenario": sc, "options": opts}
                    continue
                q = (data.get("question") or "").strip()
                # Guard against the model repeating a question it already asked.
                if q and q not in asked_already:
                    return {"type": "question", "question": q}
            else:
                raw = (resp.content or "").strip()
                if raw and raw not in asked_already and len(raw) < 400:
                    return {"type": "question", "question": raw[:500]}
        except Exception as e:
            last_err = e
    if last_err:
        logger.warning("[compliance] interview step failed: %s", last_err)
    # The per-turn prompt failed. If the user has answered enough, finalise with the
    # dedicated (retried) builder so the block-at-score reflects their answers and the
    # summary is cleaned up — rather than the fixed-10 scripted default. Otherwise ask
    # the next scripted question so the interview keeps moving.
    answered = sum(1 for m in (history or []) if m.get("role") == "user")
    if answered >= 5:
        return await _finalize_policy(manager_agent, history)
    return _scripted_step(history)


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


# ── Policy review lifecycle ───────────────────────────────────────────────────

def review_status(policy: dict) -> dict:
    """Compute when a policy is next due for review and whether it's overdue."""
    from datetime import date, timedelta
    freq = int(policy.get("review_frequency_months", 12) or 12)
    last = policy.get("last_reviewed")
    next_due = None
    if last:
        try:
            y, m, d = (int(x) for x in last[:10].split("-"))
            nd = date(y, m, d) + timedelta(days=round(freq * 30.44))
            next_due = nd.isoformat()
        except Exception:
            next_due = None
    overdue = bool(policy.get("review_due"))
    if next_due and next_due <= date.today().isoformat():
        overdue = True
    if not last:
        overdue = True
    return {"next_review": next_due, "overdue": overdue,
            "reason": policy.get("review_reason", "")}


async def policies_due_for_review() -> list[dict]:
    out = []
    for p in await database.list_risk_policies(enabled_only=True):
        st = review_status(p)
        if st["overdue"]:
            out.append({**p, **st})
    return out


def find_rc_agent(orchestrator):
    """The org's Risk & Compliance agent — any non-CEO agent with the risk skill."""
    from .skills.registry import RISK_TOOLS
    for a in orchestrator.get_agents():
        if a.config.is_ceo:
            continue
        if any(t in (a.config.skills or []) for t in RISK_TOOLS):
            return a
    return None
