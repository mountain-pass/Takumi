"""
Workflow node handlers.

Each handler is `async def handler(node, inputs, ctx) -> dict` where:
  • node   — {id, type, data:{label, config}} from the saved graph
  • inputs — the merged output of this node's upstream node(s) (a dict)
  • ctx    — NodeContext (run_id, mode, orchestrator, context map of node_id→output)

A handler returns a JSON-serialisable dict that becomes this node's output and
is fed to its descendants. Control-flow nodes (`if`) additionally return a
`_branch` key naming which source handle to follow.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

# Per-node soft timeout (seconds) so a hung node fails cleanly. Mirrors the
# task-watchdog ethos used elsewhere in the platform.
NODE_TIMEOUT = 120


class NodeContext:
    def __init__(self, *, run_id: str, mode: str, orchestrator, workflow: dict) -> None:
        self.run_id = run_id
        self.mode = mode
        self.orchestrator = orchestrator
        self.workflow = workflow
        self.context: dict[str, Any] = {}   # node_id → output


# ── templating ────────────────────────────────────────────────────────────────

_TPL = re.compile(r"\{\{\s*([^}]+?)\s*\}\}")


def _resolve_path(path: str, ctx: NodeContext, inputs: dict) -> Any:
    """Resolve a dotted path like 'nodeId.body.title' or '$.field' (current input)."""
    parts = path.split(".")
    if parts[0] in ("$", "input", "json"):
        cur: Any = inputs
        parts = parts[1:]
    elif parts[0] in ctx.context:
        cur = ctx.context[parts[0]]
        parts = parts[1:]
    else:
        cur = ctx.context
    for p in parts:
        if isinstance(cur, dict):
            cur = cur.get(p)
        elif isinstance(cur, list):
            try:
                cur = cur[int(p)]
            except Exception:
                return None
        else:
            return None
    return cur


def render(value: Any, ctx: NodeContext, inputs: dict) -> Any:
    """Render {{...}} templates in strings (and recursively in dicts/lists)."""
    if isinstance(value, str):
        def sub(m):
            r = _resolve_path(m.group(1), ctx, inputs)
            return r if isinstance(r, str) else json.dumps(r) if r is not None else ""
        # Whole-string single template → return the raw value (keeps types).
        whole = _TPL.fullmatch(value.strip())
        if whole:
            return _resolve_path(whole.group(1), ctx, inputs)
        return _TPL.sub(sub, value)
    if isinstance(value, dict):
        return {k: render(v, ctx, inputs) for k, v in value.items()}
    if isinstance(value, list):
        return [render(v, ctx, inputs) for v in value]
    return value


def _cfg(node: dict) -> dict:
    return (node.get("data") or {}).get("config") or {}


_JS_LITERALS = re.compile(r"\b(true|false|null)\b")


def _pyify(expr: str) -> str:
    """Translate the JS-style operators/literals users naturally write (n8n-style)
    into Python so conditions like `a > 1 && a < 3` evaluate — the engine uses
    Python's eval, where `&&`/`||`/`true` are syntax errors. `!=` is left intact."""
    if not isinstance(expr, str):
        return expr
    expr = expr.replace("&&", " and ").replace("||", " or ")
    expr = _JS_LITERALS.sub(lambda m: {"true": "True", "false": "False", "null": "None"}[m.group(1)], expr)
    return expr


# ── handlers ──────────────────────────────────────────────────────────────────

async def trigger_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """The entry node — passes the incoming trigger payload through."""
    return inputs or _cfg(node).get("sample") or {}


def _pairs_to_dict(pairs) -> dict:
    """Turn [{name, value}, ...] rows (n8n-style) into a dict, skipping blank names."""
    out = {}
    for p in (pairs or []):
        if isinstance(p, dict):
            name = (p.get("name") or "").strip()
            if name:
                out[name] = p.get("value", "")
    return out


async def http_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    import httpx
    cfg = render(_cfg(node), ctx, inputs)
    method = (cfg.get("method") or "GET").upper()
    url = cfg.get("url") or ""
    if not url:
        raise ValueError("HTTP node has no URL configured")

    # Query params: structured rows (preferred) when enabled.
    params = _pairs_to_dict(cfg.get("queryParams")) if cfg.get("sendQuery") else {}

    # Headers: legacy JSON dict + structured rows when enabled.
    headers = dict(cfg.get("headers") or {}) if isinstance(cfg.get("headers"), dict) else {}
    if cfg.get("sendHeaders"):
        headers.update(_pairs_to_dict(cfg.get("headerParams")))

    # Body: legacy nodes have no `sendBody` key → send `body` if present.
    # New nodes gate it on the toggle.
    send_body = cfg.get("sendBody")
    body = cfg.get("body") if (send_body or send_body is None) else None

    opts = cfg.get("options") or {}
    timeout = float(opts.get("timeout") or 0) / 1000 or NODE_TIMEOUT
    verify = not bool(opts.get("ignoreSSL"))
    follow = opts.get("followRedirects", True) is not False
    on_error = (cfg.get("onError") or "stop").lower()

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=follow, verify=verify) as client:
        kwargs: dict[str, Any] = {"headers": headers, "params": params}
        if body not in (None, ""):
            if cfg.get("bodyType") == "json" and isinstance(body, str):
                try:
                    body = json.loads(body)
                except Exception:
                    pass
            if isinstance(body, (dict, list)):
                kwargs["json"] = body
            else:
                kwargs["content"] = str(body)
        resp = await client.request(method, url, **kwargs)
    try:
        parsed = resp.json()
    except Exception:
        parsed = resp.text

    result = {"status": resp.status_code, "headers": dict(resp.headers), "body": parsed,
              "ok": resp.status_code < 400}
    # 4xx/5xx fail the node (so the Error Trigger catches it) unless "Continue on error".
    if resp.status_code >= 400 and on_error != "continue":
        snippet = parsed if isinstance(parsed, str) else json.dumps(parsed)
        raise RuntimeError(f"HTTP {resp.status_code} {resp.reason_phrase} from {url}: {snippet[:500]}")
    return result


# A deliberately small, safe environment for the code node. No imports, no
# builtins beyond a curated map. This is NOT a hardened sandbox — see plan.
_SAFE_BUILTINS = {
    "len": len, "range": range, "min": min, "max": max, "sum": sum, "sorted": sorted,
    "abs": abs, "round": round, "str": str, "int": int, "float": float, "bool": bool,
    "list": list, "dict": dict, "set": set, "tuple": tuple, "enumerate": enumerate,
    "zip": zip, "map": map, "filter": filter, "any": any, "all": all, "json": json,
}


def _render_code_tokens(code: str, ctx: NodeContext, inputs: dict, lang: str) -> str:
    """Resolve {{Node.field}} tokens dragged into code to LITERAL values so the
    code stays valid: JSON literals for JS, Python literals for Python."""
    is_js = lang in ("javascript", "js", "node")

    def sub(m):
        val = _resolve_path(m.group(1).strip(), ctx, inputs)
        return json.dumps(val) if is_js else repr(val)

    return _TPL.sub(sub, code)


async def code_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Run a small script. Language 'python' (default) or 'javascript'.
    `input` and `context` are in scope; assign to `output`. Any {{Node.field}}
    tokens (e.g. dragged from the INPUT pane) are resolved to literal values first."""
    cfg = _cfg(node)
    lang = (cfg.get("language") or "python").lower()
    code = cfg.get("code") or ("output = input" if lang == "python" else "output = input;")
    code = _render_code_tokens(code, ctx, inputs, lang)
    if lang in ("javascript", "js", "node"):
        return await _run_js(code, inputs, ctx)

    import re as _re
    import textwrap as _tw
    env = {"__builtins__": _SAFE_BUILTINS}
    local = {"input": inputs, "context": ctx.context, "output": None}
    has_return = bool(_re.search(r"(^|\n)[ \t]*return\b", code))
    if has_return:
        # Wrap so a top-level `return ...` works (like JS / n8n).
        wrapped = ("def __wf_main(input, context):\n" + _tw.indent(code, "    ") +
                   "\n    return locals().get('output')\n__wf_result = __wf_main(input, context)")
        exec(compile(wrapped, "<code-node>", "exec"), env, local)
        out = local.get("__wf_result")
    else:
        try:
            # A bare expression (e.g. `input['x'] * 2`) is allowed too.
            out = eval(compile(code, "<code-node>", "eval"), env, local)
        except SyntaxError:
            exec(compile(code, "<code-node>", "exec"), env, local)
            out = local.get("output")
    return _wrap_code_output(out)


async def _node_exec(body: str, inputs: dict, ctx: NodeContext):
    """Run a JS `body` (which must assign `output`) in a `node` subprocess and return
    the parsed JSON `output`. `input`/`context` are exposed as vars. The script is
    piped via stdin and input/context go through temp files — never argv/env — so big
    upstream outputs don't blow past ARG_MAX ('[Errno 7] Argument list too long')."""
    import shutil, os, tempfile
    node_bin = shutil.which("node")
    if not node_bin:
        raise RuntimeError("JavaScript requires Node.js on PATH (not found)")
    in_path = ctx_path = None
    try:
        fd_i, in_path = tempfile.mkstemp(suffix=".json", prefix="wf_in_")
        with os.fdopen(fd_i, "w") as f:
            json.dump(inputs, f)
        fd_c, ctx_path = tempfile.mkstemp(suffix=".json", prefix="wf_ctx_")
        with os.fdopen(fd_c, "w") as f:
            json.dump(ctx.context, f)
        head = ("const __fs = require('fs');\n"
                "const input = JSON.parse(__fs.readFileSync(process.env.WF_INPUT_FILE, 'utf8') || '{}');\n"
                "const context = JSON.parse(__fs.readFileSync(process.env.WF_CONTEXT_FILE, 'utf8') || '{}');\n")
        harness = head + body + "\nprocess.stdout.write(JSON.stringify(output === undefined ? null : output));\n"
        proc = await asyncio.create_subprocess_exec(
            node_bin, "-",   # read the script from stdin (avoids argv size limits)
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env={"WF_INPUT_FILE": in_path, "WF_CONTEXT_FILE": ctx_path,
                 "PATH": os.environ.get("PATH", "")},
        )
        out, err = await asyncio.wait_for(proc.communicate(harness.encode()), timeout=NODE_TIMEOUT - 5)
        if proc.returncode != 0:
            raise RuntimeError(f"JS error: {(err or b'').decode()[:300]}")
        try:
            return json.loads((out or b"").decode() or "null")
        except Exception:
            return (out or b"").decode()
    finally:
        for p in (in_path, ctx_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass


def _wrap_code_output(out):
    """Node outputs must be dicts. Pass dicts through; expose a list as `items` (so a
    Loop node can iterate it); wrap a scalar as `result`."""
    if isinstance(out, dict):
        return out
    if isinstance(out, list):
        return {"items": out}
    return {"result": out}


async def _run_js(code: str, inputs: dict, ctx: NodeContext) -> dict:
    """Execute a JS code node. Supports `return ...`, assigning `output`, or a bare
    expression (e.g. an array/object literal) — like the Python code node."""
    if re.search(r"(^|\n)\s*return\b", code):
        body = "const __wf_main = () => {\n" + code + "\n};\nconst output = __wf_main();\n"
    elif re.search(r"\boutput\b\s*=", code):
        body = "let output;\n" + code + "\n"
    else:
        # No return and no `output =` → treat the whole body as a single expression.
        body = "const output = (\n" + code + "\n);\n"
    parsed = await _node_exec(body, inputs, ctx)
    return _wrap_code_output(parsed)


async def _run_js_bools(exprs: list[str], inputs: dict, ctx: NodeContext) -> list[bool]:
    """Evaluate a list of JS boolean expressions in ONE node process (so a Switch's
    N rules cost a single subprocess). Each expr can use `input`/`context`. A failing
    expr yields False. ponytail: one subprocess per condition-node execution — fine
    outside hot paths; a Loop body with a JS If pays it per item."""
    body = ("const __exprs = " + json.dumps(exprs) + ";\n"
            "const output = __exprs.map(e => { try { return Boolean(eval(e)); } catch (_) { return false; } });\n")
    res = await _node_exec(body, inputs, ctx)
    return [bool(x) for x in res] if isinstance(res, list) else [False] * len(exprs)


async def _eval_conditions(exprs: list, lang: str, inputs: dict, ctx: NodeContext) -> list[bool]:
    """Evaluate condition expressions in the chosen language. {{tokens}} are rendered
    to literals first (same in both languages); only the eval semantics differ —
    Python (with _pyify so &&/|| still work) or JavaScript (via Node)."""
    rendered = [str(render(str(e or ""), ctx, inputs)) for e in exprs]
    if lang == "javascript":
        try:
            return await _run_js_bools(rendered, inputs, ctx)
        except Exception as e:
            logger.warning("[workflow] JS condition eval failed: %s", e)
            return [False] * len(rendered)
    out = []
    for r in rendered:
        try:
            out.append(bool(eval(compile(_pyify(r), "<cond>", "eval"),
                                 {"__builtins__": _SAFE_BUILTINS},
                                 {"input": inputs, "context": ctx.context})))
        except Exception as e:
            logger.debug("[workflow] python condition failed: %s", e)
            out.append(False)
    return out


async def if_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Evaluate a boolean condition; route to the 'true' or 'false' handle."""
    cfg = _cfg(node)
    expr = cfg.get("condition") or "True"
    result = (await _eval_conditions([expr], cfg.get("lang") or "python", inputs, ctx))[0]
    return {"result": result, "_branch": "true" if result else "false"}


async def switch_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Route to one of several outputs by evaluating ordered rules (in cfg['lang'] =
    python|javascript). The first true rule's index becomes the taken handle; falls
    through to the 'default' handle when none match."""
    cfg = _cfg(node)
    rules = cfg.get("rules") or []
    exprs = [(r.get("condition") if isinstance(r, dict) else r) for r in rules]
    bools = await _eval_conditions(exprs, cfg.get("lang") or "python", inputs, ctx)
    matched = "default"
    for i, ok in enumerate(bools):
        if exprs[i] and ok:
            matched = str(i)
            break
    return {"_branch": matched, "matched": matched,
            "value": inputs if isinstance(inputs, dict) else {"value": inputs}}


async def filter_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Pass input through if the condition holds; otherwise stop this branch."""
    cfg = _cfg(node)
    expr = cfg.get("condition") or "True"
    keep = (await _eval_conditions([expr], cfg.get("lang") or "python", inputs, ctx))[0]
    if keep:
        out = inputs if isinstance(inputs, dict) else {"value": inputs}
        return {**out, "_kept": True}
    # Sentinel handle that no edge matches → downstream is pruned.
    return {"_branch": "__dropped__", "_kept": False}


async def stop_error_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Throw an error to fail the run with a custom message."""
    cfg = _cfg(node)
    msg = render(cfg.get("message") or "Workflow stopped", ctx, inputs)
    raise RuntimeError(str(msg))


def _coerce(val, ftype):
    """Coerce a templated value to the field's declared type (manual mapping)."""
    if ftype in (None, "string"):
        return val if isinstance(val, str) else json.dumps(val) if isinstance(val, (dict, list)) else "" if val is None else str(val)
    if ftype == "number":
        try:
            f = float(val)
            return int(f) if f.is_integer() else f
        except (TypeError, ValueError):
            return val
    if ftype == "boolean":
        if isinstance(val, str):
            return val.strip().lower() in ("true", "1", "yes", "on")
        return bool(val)
    if ftype in ("array", "object"):
        if isinstance(val, str):
            try:
                return json.loads(val)
            except (TypeError, ValueError):
                return val
        return val
    return val


async def set_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Edit Fields (Set): add/override fields. Two modes:
    - 'manual': `fields` is a list of {name, type, value}; values are templated then
      coerced to the declared type.
    - 'json': `assignments` is an object of name → value (values templated).
    keep_only drops the original input. Default mode preserves legacy nodes (json if
    `assignments` is present, else manual)."""
    cfg = _cfg(node)
    mode = cfg.get("mode") or ("json" if cfg.get("assignments") else "manual")
    rendered: dict = {}
    if mode == "json":
        assignments = cfg.get("assignments") or {}
        rendered = render(assignments, ctx, inputs) if isinstance(assignments, dict) else {}
    else:
        for f in cfg.get("fields") or []:
            name = (f.get("name") or "").strip()
            if not name:
                continue
            rendered[name] = _coerce(render(f.get("value"), ctx, inputs), f.get("type"))
    base = {} if cfg.get("keep_only") else (inputs if isinstance(inputs, dict) else {"value": inputs})
    return {**base, **rendered}


async def datetime_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Date & Time: produce or transform a timestamp. Actions: 'now' (default),
    'format' (parse `field` and reformat), 'add' (offset seconds)."""
    from datetime import datetime, timedelta, timezone
    cfg = _cfg(node)
    action = (cfg.get("action") or "now").lower()
    if action == "now":
        return {"datetime": datetime.now(timezone.utc).isoformat()}
    if action == "add":
        try:
            base = datetime.fromisoformat(str(render(cfg.get("value") or "", ctx, inputs))) if cfg.get("value") else datetime.now(timezone.utc)
        except Exception:
            base = datetime.now(timezone.utc)
        secs = float(cfg.get("seconds") or 0)
        return {"datetime": (base + timedelta(seconds=secs)).isoformat()}
    # format
    raw = render(cfg.get("value") or "", ctx, inputs)
    fmt = cfg.get("format") or "%Y-%m-%d %H:%M:%S"
    try:
        dt = datetime.fromisoformat(str(raw))
        return {"datetime": dt.strftime(fmt)}
    except Exception:
        return {"datetime": str(raw)}


async def loop_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Split an array field into items the downstream branch runs over.
    Phase-1: returns the items list; the engine fans the downstream branch out."""
    cfg = _cfg(node)
    field = cfg.get("items_field") or "items"
    # Accept a {{token}} (e.g. {{Code.items}}) — render it; a single whole-string token
    # resolves to the list directly. Otherwise treat the field as a dotted path / key.
    rendered = render(field, ctx, inputs)
    if isinstance(rendered, list):
        items = rendered
    else:
        path = rendered if isinstance(rendered, str) else field
        items = _resolve_path(path, ctx, inputs)
        if not isinstance(items, list) and isinstance(inputs, dict):
            items = inputs.get(path)
    items = items if isinstance(items, list) else []
    return {"items": items, "count": len(items), "_loop": True}


async def merge_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Combine all upstream outputs into one object (engine passes them via inputs._merged)."""
    merged = inputs.get("_merged") if isinstance(inputs, dict) else None
    if merged is None:
        return inputs or {}
    return {"merged": merged}


async def llm_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Run a prompt against a chosen agent, optionally overriding which provider
    and model run the task (like n8n's agent node). The compliance gate is applied
    by the engine AFTER this returns (it needs the run/step context)."""
    cfg = _cfg(node)
    prompt = render(cfg.get("prompt") or "", ctx, inputs)
    system = cfg.get("system") or "You are a helpful assistant inside an automated workflow."
    agent_id = cfg.get("agent_id") or ""
    orch = ctx.orchestrator

    agent = None
    if orch is not None:
        agents = orch.get_agents()
        if agent_id:
            agent = next((a for a in agents if a.config.id == agent_id), None)
        if agent is None:
            agent = next((a for a in agents if not a.config.is_ceo), None) or (agents[0] if agents else None)
    if agent is None:
        raise ValueError("No agent available to run the LLM node")

    # Provider/model override: build a fresh adapter for the chosen provider.
    adapter = agent._adapter
    model = cfg.get("model") or agent.config.llm_model
    provider_id = cfg.get("api_provider_id")
    if provider_id:
        from ..llm_adapters.factory import get_adapter_for_provider
        adapter = get_adapter_for_provider(provider_id, agent.settings)

    if not prompt:
        prompt = json.dumps(inputs)[:4000] if inputs else "Proceed."
    resp = await adapter.complete(
        system_prompt=system,
        messages=[{"role": "user", "content": str(prompt)}],
        model=model,
        max_tokens=int(cfg.get("max_tokens") or 1024),
    )
    return {"text": resp.content, "agent": agent.config.name, "agent_id": agent.config.id, "model": model}


async def wait_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Pause the workflow for a bounded number of seconds, then pass input through."""
    cfg = _cfg(node)
    try:
        secs = float(cfg.get("seconds") or 1)
    except Exception:
        secs = 1
    secs = max(0, min(secs, NODE_TIMEOUT - 5))   # bounded by the node timeout
    await asyncio.sleep(secs)
    return inputs if isinstance(inputs, dict) else {"value": inputs}


async def noop_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Do nothing — pass input straight through (useful as a join/placeholder)."""
    return inputs if isinstance(inputs, dict) else {"value": inputs}


async def error_trigger_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Catch-all entry: runs only when another node fails. Receives the error
    context {error, node, node_id, run_id, workflow} for the error branch to handle."""
    return inputs if isinstance(inputs, dict) else {"error": str(inputs)}


async def variable_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Assign a named, overwritable workflow variable. The (templated) value is stored
    in the run context under its name, so downstream nodes read it as {{name}} — and a
    later Variable node with the same name overwrites it."""
    cfg = _cfg(node)
    name = str(cfg.get("name") or "var").strip() or "var"
    value = render(cfg.get("value"), ctx, inputs) if cfg.get("value") not in (None, "") else inputs
    ctx.context[name] = value          # overwritable; resolvable as {{name}}
    return {"name": name, "value": value}


# File nodes mirror the agent file skills' posture (any path the backend can reach;
# parent dirs auto-created; reads capped). Paths/content are templated.
_FILE_READ_CAP = 100_000


async def write_file_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Write (templated) content to a file. mode='overwrite' (default) or 'append'."""
    import os
    cfg = _cfg(node)
    path = render(str(cfg.get("path") or ""), ctx, inputs)
    if not isinstance(path, str) or not path.strip():
        raise ValueError("Write File: a file path is required")
    path = os.path.expanduser(path.strip())
    content = render(cfg.get("content"), ctx, inputs)
    if content is None:
        content = inputs
    text = content if isinstance(content, str) else json.dumps(content, indent=2, default=str)
    file_mode = "a" if str(cfg.get("mode") or "overwrite").lower().startswith("a") else "w"
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, file_mode, encoding="utf-8") as f:
        f.write(text)
    return {"path": path, "bytes": len(text.encode("utf-8")), "mode": file_mode, "ok": True}


async def read_file_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Read a text file. Output {path, content, bytes}; content capped. Optionally
    parse JSON content into `json` when the file looks like JSON."""
    import os
    cfg = _cfg(node)
    path = render(str(cfg.get("path") or ""), ctx, inputs)
    if not isinstance(path, str) or not path.strip():
        raise ValueError("Read File: a file path is required")
    path = os.path.expanduser(path.strip())
    if not os.path.exists(path):
        raise FileNotFoundError(f"File not found: {path}")
    if os.path.isdir(path):
        raise IsADirectoryError(f"'{path}' is a directory")
    size = os.path.getsize(path)
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read(_FILE_READ_CAP)
    out = {"path": path, "content": content, "bytes": size,
           "truncated": size > len(content.encode("utf-8"))}
    if cfg.get("parse_json"):
        try:
            out["json"] = json.loads(content)
        except (ValueError, TypeError):
            out["json"] = None
    return out


async def respond_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Mark the payload to return to a webhook caller. The webhook route returns
    the output of the (first) respond node in the run."""
    cfg = _cfg(node)
    body = render(cfg.get("body"), ctx, inputs) if cfg.get("body") not in (None, "") else inputs
    # The body IS the node output (no {"response": ...} wrapper) so the OUTPUT pane and
    # the webhook reply show exactly what the caller receives. Engine wraps non-dicts.
    return body if isinstance(body, dict) else {"value": body}


async def subworkflow_node(node: dict, inputs: dict, ctx: NodeContext) -> dict:
    """Run another workflow by name/id and return its final output. Bounded depth
    to prevent infinite recursion."""
    from .. import database
    from .engine import run_workflow

    if getattr(ctx, "depth", 0) >= 3:
        raise ValueError("Sub-workflow nesting too deep (max 3)")
    cfg = _cfg(node)
    target = None
    wf_id = cfg.get("workflow_id")
    name = cfg.get("workflow_name")
    if wf_id:
        target = await database.get_workflow(wf_id)
    if target is None and name:
        wfs = await database.list_workflows()
        target = next((w for w in wfs if (w.get("name") or "").lower() == name.lower()), None)
    if target is None:
        raise ValueError("Sub-workflow not found (set workflow_id or workflow_name)")

    child_depth = getattr(ctx, "depth", 0) + 1
    run_id = await run_workflow(target, inputs if isinstance(inputs, dict) else {"value": inputs},
                                mode=ctx.mode, trigger_source="subworkflow",
                                orchestrator=ctx.orchestrator, _depth=child_depth)
    run = await database.get_run(run_id)
    steps = run.get("steps", []) if run else []
    final = steps[-1]["output"] if steps else {}
    return {"workflow": target["name"], "run_id": run_id,
            "status": run.get("status") if run else "unknown", "output": final}


NODE_HANDLERS = {
    "trigger": trigger_node,
    "http": http_node,
    "code": code_node,
    "if": if_node,
    "loop": loop_node,
    "merge": merge_node,
    "llm": llm_node,
    "wait": wait_node,
    "noop": noop_node,
    "respond": respond_node,
    "subworkflow": subworkflow_node,
    "switch": switch_node,
    "filter": filter_node,
    "stop_error": stop_error_node,
    "set": set_node,
    "datetime": datetime_node,
    "error_trigger": error_trigger_node,
    "variable": variable_node,
    "write_file": write_file_node,
    "read_file": read_file_node,
}
