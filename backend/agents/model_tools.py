"""
Secondary "specialist" models attached to an agent, exposed as tools its main
brain can call. Each extra model has a kind:

  - text   → ask_<label>(prompt): route a sub-prompt to a specialist text model
             (code / reasoning / a stronger model) and return its answer.
  - vision → see_<label>(image_url, question): analyse an image with a vision model.
  - image  → draw_<label>(prompt): generate an image (OpenAI-compatible
             /images/generations) and save it as a viewable artifact.

Adapters for the secondary models are resolved from their api_provider_id, the
same way the orchestrator resolves an agent's main adapter.
"""
from __future__ import annotations

import base64
import logging
import re

logger = logging.getLogger(__name__)


def slug(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (label or "model").lower()).strip("_") or "model"


def tool_name(kind: str, label: str) -> str:
    prefix = {"text": "ask", "vision": "see", "image": "draw"}.get(kind, "ask")
    return f"{prefix}_{slug(label)}"


def tools_for_agent(extra_models: list[dict]) -> list[dict]:
    """Return tool descriptors for an agent's extra models."""
    out = []
    for m in extra_models or []:
        kind = (m.get("kind") or "text").lower()
        label = m.get("label") or m.get("llm_model") or "model"
        name = tool_name(kind, label)
        desc = m.get("description", "")
        model = m.get("llm_model", "")
        if kind == "vision":
            out.append({
                "name": name, "kind": kind, "config": m,
                "description": f"Analyse an image with the {label} vision model ({model}). {desc}".strip(),
                "parameters": {"image_url": "URL or data: URI of the image", "question": "What to analyse / ask about it"},
            })
        elif kind == "image":
            out.append({
                "name": name, "kind": kind, "config": m,
                "description": f"Generate an image with the {label} model ({model}); it's saved as a viewable artifact. {desc}".strip(),
                "parameters": {"prompt": "Description of the image to generate"},
            })
        else:  # text
            out.append({
                "name": name, "kind": kind, "config": m,
                "description": f"Ask the specialist {label} model ({model}) — use for tasks it's better at. {desc}".strip(),
                "parameters": {"prompt": "The prompt / question to send to this model"},
            })
    return out


async def _build_adapter(api_provider_id: str, settings):
    """Resolve an adapter (with credentials) for a secondary model's provider."""
    from .. import database
    from ..llm_adapters import get_adapter
    from ..models import LLMProvider
    prov = await database.get_api_provider(api_provider_id)
    if not prov:
        raise ValueError("Provider not found for this model")
    runtime = {"llm_api_key": prov.get("api_key", ""), "llm_base_url": prov.get("base_url", "")}
    provider_type = prov.get("provider", "")
    try:
        llm_provider = LLMProvider(provider_type)
    except ValueError:
        llm_provider = LLMProvider.CUSTOM
    return get_adapter(llm_provider, settings, runtime), prov


async def run_text(cfg: dict, settings, prompt: str) -> str:
    adapter, _ = await _build_adapter(cfg.get("api_provider_id", ""), settings)
    resp = await adapter.complete(
        system_prompt="You are a focused specialist model. Answer the request directly and completely.",
        messages=[{"role": "user", "content": prompt}],
        model=cfg.get("llm_model", ""),
        max_tokens=4000,
    )
    return resp.content or ""


async def run_vision(cfg: dict, settings, image_url: str, question: str) -> str:
    import httpx
    raw, mime = None, "image/png"
    if image_url.startswith("data:"):
        try:
            header, b64 = image_url.split(",", 1)
            mime = header.split(":", 1)[1].split(";", 1)[0]
            raw = base64.b64decode(b64)
        except Exception:
            return "Error: could not decode the image data URI."
    else:
        url = image_url
        if url.startswith("/"):  # internal artifact/upload path
            from ..config import get_settings
            port = getattr(get_settings(), "port", 8000)
            url = f"http://localhost:{port}{url}"
        try:
            async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
                r = await client.get(url)
                r.raise_for_status()
                raw = r.content
                mime = r.headers.get("content-type", "image/png").split(";")[0]
        except Exception as e:
            return f"Error fetching image: {e}"
    b64 = base64.b64encode(raw).decode("ascii")
    adapter, _ = await _build_adapter(cfg.get("api_provider_id", ""), settings)
    resp = await adapter.complete(
        system_prompt="You are a precise visual analyst.",
        messages=[{"role": "user", "content": [
            {"type": "text", "text": question or "Describe this image in detail."},
            {"type": "image", "media_type": mime, "data": b64},
        ]}],
        model=cfg.get("llm_model", ""),
        max_tokens=2000,
    )
    return resp.content or ""


async def generate_image(cfg: dict, settings, prompt: str) -> dict:
    """Generate an image via an OpenAI-compatible /images/generations endpoint.
    Returns {"html": <img wrapper>, "title": ...} for saving as an artifact."""
    import httpx
    from .. import database
    prov = await database.get_api_provider(cfg.get("api_provider_id", ""))
    if not prov:
        raise ValueError("Provider not found for this model")
    base = (prov.get("base_url") or "").rstrip("/")
    api_key = prov.get("api_key", "")
    url = base + "/images/generations"
    body = {"model": cfg.get("llm_model", ""), "prompt": prompt, "n": 1,
            "size": cfg.get("size", "1024x1024"), "response_format": "b64_json"}
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"} if api_key else {}
    async with httpx.AsyncClient(timeout=120) as client:
        r = await client.post(url, headers=headers, json=body)
        if r.status_code >= 400:
            raise ValueError(f"Image generation failed (HTTP {r.status_code}): {r.text[:200]}")
        data = r.json().get("data", [{}])[0]
    if data.get("b64_json"):
        src = f"data:image/png;base64,{data['b64_json']}"
    elif data.get("url"):
        src = data["url"]
    else:
        raise ValueError("Image generation returned no image")
    title = prompt[:80]
    html = (
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        f"<title>{title}</title><style>body{{margin:0;background:#0f1117;display:flex;"
        "align-items:center;justify-content:center;min-height:100vh}img{max-width:100%;"
        "max-height:100vh;object-fit:contain}</style></head>"
        f"<body><img src='{src}' alt='generated image'></body></html>"
    )
    return {"html": html, "title": title}
