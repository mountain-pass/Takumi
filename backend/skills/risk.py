"""
Risk & Compliance skills — the Risk & Compliance agent's tools. ISO 31000 risk
scoring, secret-leak detection, outbound-comms review, and the risk register.
"""
from __future__ import annotations

import json

from .. import compliance


def _fmt(rec: dict) -> str:
    lines = [
        f"Risk assessment — **{rec['level'].upper()}** (score {rec['score']}/25, "
        f"threshold {rec['threshold']}) → verdict: **{rec['verdict']}**",
    ]
    if rec.get("rationale"):
        lines.append(rec["rationale"])
    if rec.get("findings"):
        lines.append("Secret/sensitive findings: " +
                     ", ".join(f"{f['type']} ({f['preview']})" for f in rec["findings"]))
    cats = rec.get("categories", {})
    if cats:
        top = sorted(cats.items(), key=lambda kv: kv[1].get("score", 0), reverse=True)[:3]
        lines.append("Top categories: " + "; ".join(
            f"{c} L{v['likelihood']}×C{v['consequence']}={v['score']}" for c, v in top))
    return "\n".join(lines)


async def assess_risk(subject: str = "", categories: dict | str = None, content: str = "") -> str:
    """Score work against ISO 31000. `categories` = {category: {likelihood:1-5,
    consequence:1-5, note}}; the agent fills these from its analysis."""
    if isinstance(categories, str):
        try:
            categories = json.loads(categories)
        except Exception:
            categories = {}
    rec = await compliance.finalize(subject or "work", categories or {}, content or "")
    return _fmt(rec)


async def scan_secrets(text: str = "") -> str:
    """Detect leaked secrets / credentials / PII in text."""
    findings = compliance.scan_secrets(text or "")
    if not findings:
        return "No secrets or sensitive values detected."
    return "⚠️ Detected:\n" + "\n".join(f"- {f['type']}: {f['preview']}" for f in findings)


async def review_outbound(message: str = "", recipient: str = "") -> str:
    """Review an outbound communication before it is sent — secret/PII scan plus a
    compliance checklist for the agent to judge against."""
    findings = compliance.scan_secrets(message or "")
    out = [f"Outbound review for recipient: {recipient or '(unspecified)'}"]
    if findings:
        out.append("❌ BLOCK — sensitive data present:")
        out += [f"  - {f['type']}: {f['preview']}" for f in findings]
    else:
        out.append("No secrets/PII detected. Still verify: correct recipient, no confidential "
                   "data, appropriate tone, required disclaimers, and that it matches the spec.")
    return "\n".join(out)


async def risk_register(limit: int = 15) -> str:
    """List recent entries from the risk register."""
    from .. import database
    rows = await database.get_risk_assessments(int(limit))
    if not rows:
        return "Risk register is empty."
    out = ["Recent risk assessments:"]
    for r in rows[: int(limit)]:
        out.append(f"- [{r['level'].upper()} {r['score']}/25 · {r['verdict']}] {r['subject'][:60]} "
                   f"({(r['created_at'] or '')[:16]})")
    return "\n".join(out)
