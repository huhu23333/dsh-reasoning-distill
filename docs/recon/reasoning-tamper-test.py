#!/usr/bin/env python3
"""
测试：改写 reasoning/thinking 内容后，DeepSeek API 是否仍接受后续请求。

复刻 DSH 适配器的两条真实路径：
  A. Messages(Anthropic) 路由  https://api.deepseek.com/anthropic/v1/messages   ← deepseek-official 适配器实际使用
  B. Chat Completions 路由     https://api.deepseek.com/chat/completions        ← 官方 OpenAI 兼容路径

判定矩阵（两种签名策略 × 两种改写程度）：
  1 baseline  原样回传（含原 signature / reasoning_content）
  2 modified+keepSig   改写文本，保留原 signature
  3 modified+dropSig   改写文本，去掉 signature 字段
  4 truncated+keepSig  截断到前 30 字符，保留原 signature

密钥只在运行时从 ~/.dsh/.credentials.yaml 读取，不写入任何文件、不打印。
"""
import json
import os
import sys
import urllib.error
import urllib.request

CRED = os.path.expanduser("~/.dsh/.credentials.yaml")
MSGS_URL = "https://api.deepseek.com/anthropic/v1/messages"
CHAT_URL = "https://api.deepseek.com/chat/completions"
MODEL = "deepseek-flash"
PROXY = os.environ.get("REASONING_TEST_PROXY")  # 可选：显式代理


def load_key() -> str:
    sys.path.insert(0, "/usr/lib/python3/dist-packages")
    import yaml  # type: ignore
    doc = yaml.safe_load(open(CRED, encoding="utf-8"))
    ref = doc["refs"]["DEEPSEEK_API_KEY"]
    if isinstance(ref, str) and ref in (doc.get("records") or {}):
        rec = doc["records"][ref]
        ref = rec.get("payload") if isinstance(rec, dict) else rec
        if isinstance(ref, dict):
            ref = ref.get("value") or ref.get("secret") or ref.get("apiKey")
    if not isinstance(ref, str) or len(ref) < 8:
        raise SystemExit("无法解析 DEEPSEEK_API_KEY")
    return ref


def call(url: str, headers: dict, body: dict, timeout: int = 180):
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    if PROXY:
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
    else:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:400]}
    except Exception as e:  # noqa: BLE001
        return -1, {"transport": f"{type(e).__name__}: {e}"}


def brief(payload: dict) -> str:
    if "error" in payload:
        err = payload["error"]
        msg = err.get("message") if isinstance(err, dict) else str(err)
        return f"ERROR {str(msg)[:160]}"
    if "transport" in payload:
        return f"TRANSPORT {payload['transport'][:160]}"
    blocks = payload.get("content") or []
    kinds = [b.get("type") for b in blocks]
    txt = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    return f"OK blocks={kinds} text={txt[:70]!r}"


def tool_schema_anthropic():
    return [{
        "name": "get_weather",
        "description": "Get current weather for a city.",
        "input_schema": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    }]


def tool_schema_openai():
    return [{
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get current weather for a city.",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }]


ASK = ("I need the current weather in Paris. Call the get_weather tool for Paris. "
       "Keep your reasoning short, then call the tool. Do not answer in text.")


def run_messages_route(key: str) -> list:
    hdr = {"x-api-key": key, "anthropic-version": "2023-06-01",
           "content-type": "application/json"}
    base = {
        "model": MODEL,
        "max_tokens": 1200,
        "thinking": {"type": "enabled"},
        "output_config": {"effort": "low"},
        "tools": tool_schema_anthropic(),
    }
    st, first = call(MSGS_URL, hdr, {**base, "messages": [
        {"role": "user", "content": [{"type": "text", "text": ASK}]}]})
    print(f"[Messages] 第 1 跳 {st}: {brief(first)}")
    if st != 200:
        return [("Messages/获取原始thinking", st, brief(first))]
    blocks = first.get("content") or []
    think = next((b for b in blocks if b.get("type") == "thinking"), None)
    call_blk = next((b for b in blocks if b.get("type") == "tool_use"), None)
    if not think or not call_blk:
        print("  ! 本轮没有同时返回 thinking + tool_use，无法做替换测试")
        return [("Messages/前提", st, f"blocks={[b.get('type') for b in blocks]}")]
    orig = think.get("thinking", "")
    sig = think.get("signature")
    print(f"  原始 thinking {len(orig)} 字符, signature={'有' if sig else '无'}"
          f"{f'（UUID格式={is_uuid(sig)}）' if sig else ''}")
    print(f"  tool_use: {call_blk.get('name')} input={json.dumps(call_blk.get('input'), ensure_ascii=False)[:80]}")

    follow = {"role": "user", "content": [{
        "type": "tool_result",
        "tool_use_id": call_blk.get("id"),
        "content": [{"type": "text", "text": "Sunny, 22C"}]}]}
    check = {"role": "user", "content": [{"type": "text",
             "text": "Given that result, reply with exactly one short sentence."}]}

    modified = ("I should call get_weather for Paris. [REWRITTEN BY TEST]" if len(orig) > 60 else orig)
    truncated = orig[:30]

    variants = [
        ("baseline 原样回传", [think, call_blk]),
        ("modified+keepSig", [{**think, "thinking": modified}, call_blk]),
        ("modified+dropSig", [{"type": "thinking", "thinking": modified}, call_blk]),
        ("truncated+keepSig", [{**think, "thinking": truncated}, call_blk]),
    ]
    out = []
    for name, content in variants:
        body = {**base, "messages": [
            {"role": "user", "content": [{"type": "text", "text": ASK}]},
            {"role": "assistant", "content": content},
            follow, check,
        ]}
        st2, resp = call(MSGS_URL, hdr, body)
        out.append((f"Messages/{name}", st2, brief(resp)))
        print(f"  [{name}] {st2}: {brief(resp)}")
    return out


def is_uuid(s) -> bool:
    import re
    return bool(re.fullmatch(r"[0-9a-fA-F-]{36}", str(s or "")))


def run_chat_route(key: str) -> list:
    hdr = {"Authorization": f"Bearer {key}", "content-type": "application/json"}
    base = {
        "model": MODEL,
        "max_tokens": 1200,
        "thinking": {"type": "enabled"},
        "reasoning_effort": "low",
        "tools": tool_schema_openai(),
    }
    st, first = call(CHAT_URL, hdr, {**base, "messages": [
        {"role": "user", "content": ASK}]})
    print(f"[Chat] 第 1 跳 {st}: ", end="")
    if st != 200:
        print(brief(first))
        return [("Chat/获取原始reasoning_content", st, brief(first))]
    msg = (first.get("choices") or [{}])[0].get("message") or {}
    rc = msg.get("reasoning_content") or ""
    tcals = msg.get("tool_calls") or []
    print(f"reasoning_content {len(rc)} 字符, tool_calls={len(tcals)}")
    if not rc or not tcals:
        return [("Chat/前提", st, f"rc={len(rc)} tc={len(tcals)}")]
    follow = {"role": "tool", "tool_call_id": tcals[0]["id"], "content": "Sunny, 22C"}
    check = {"role": "user", "content": "Given that, reply with one short sentence."}
    modified = "I should call get_weather for Paris. [REWRITTEN BY TEST]"
    out = []
    for name, rcv in (("baseline 原样回传", rc), ("modified 改写回传", modified)):
        asst = {"role": "assistant", "content": msg.get("content") or "",
                "reasoning_content": rcv, "tool_calls": tcals}
        st2, resp = call(CHAT_URL, hdr, {**base, "messages": [
            {"role": "user", "content": ASK}, asst, follow, check]})
        out.append((f"Chat/{name}", st2, brief(resp) if "error" in resp
                    else f"OK finish={resp['choices'][0].get('finish_reason')} "
                         f"text={(resp['choices'][0]['message'].get('content') or '')[:70]!r}"))
        print(f"  [{name}] {st2}: {out[-1][2]}")
    return out


if __name__ == "__main__":
    key = load_key()
    print(f"密钥已加载（长度 {len(key)}，未打印）\n")
    results = []
    results += run_messages_route(key)
    print()
    results += run_chat_route(key)
    print("\n===== 判定汇总 =====")
    for name, st, desc in results:
        verdict = "接受" if st == 200 else ("拒绝" if st >= 400 else "未知")
        print(f"{verdict:<4} {st:<5} {name:<38} {desc}")
