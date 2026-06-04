"""
Multimodal content conversion.

Internally a message's `content` is either a plain string (the common case) or
a list of normalized parts:

    {"type": "text",  "text": "..."}
    {"type": "image", "media_type": "image/png", "data": "<base64>"}

Each provider expects a different shape, so these helpers translate the
normalized parts into the format that provider's SDK/API wants. When `content`
is a plain string they pass it through unchanged, so text-only flows are
untouched.
"""
from __future__ import annotations


def _parts(content):
    return content if isinstance(content, list) else None


def to_openai(content):
    """OpenAI / OpenRouter / Custom / Ollama-Cloud chat content."""
    parts = _parts(content)
    if parts is None:
        return content
    out = []
    for p in parts:
        if p.get("type") == "text":
            out.append({"type": "text", "text": p.get("text", "")})
        elif p.get("type") == "image":
            uri = f"data:{p.get('media_type', 'image/png')};base64,{p.get('data', '')}"
            out.append({"type": "image_url", "image_url": {"url": uri}})
    return out


def to_anthropic(content):
    parts = _parts(content)
    if parts is None:
        return content
    out = []
    for p in parts:
        if p.get("type") == "text":
            out.append({"type": "text", "text": p.get("text", "")})
        elif p.get("type") == "image":
            out.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": p.get("media_type", "image/png"),
                    "data": p.get("data", ""),
                },
            })
    return out


def to_gemini(content):
    """Returns a list of google-generativeai parts."""
    parts = _parts(content)
    if parts is None:
        return [content]
    out = []
    for p in parts:
        if p.get("type") == "text":
            out.append(p.get("text", ""))
        elif p.get("type") == "image":
            out.append({"inline_data": {"mime_type": p.get("media_type", "image/png"), "data": p.get("data", "")}})
    return out


def flatten_text(content):
    """Collapse normalized content to a plain string for text-only providers.

    Images are replaced with a short placeholder note so the model at least
    knows an image was attached even though it can't see it.
    """
    parts = _parts(content)
    if parts is None:
        return content
    out = []
    for p in parts:
        if p.get("type") == "text":
            out.append(p.get("text", ""))
        elif p.get("type") == "image":
            out.append("[An image was attached but this model cannot view images.]")
    return "\n".join(out)


def to_ollama_native(content):
    """Ollama /api/chat: returns (text_content, images_list | None)."""
    parts = _parts(content)
    if parts is None:
        return content, None
    texts, images = [], []
    for p in parts:
        if p.get("type") == "text":
            texts.append(p.get("text", ""))
        elif p.get("type") == "image":
            images.append(p.get("data", ""))
    return "\n".join(texts), (images or None)
