#!/usr/bin/env python3
"""
第四轮：模拟插件的真实运行方式 —— 多轮工具链中，每一轮都把 thinking 替换成"蒸馏版"再回传。

判定：全链每一跳是否 200；替换后的 thinking 是否稳定被接受。
同时记录 usage 里的 cache_read_input_tokens，观察替换对缓存命中的影响。
"""
import json
import os
import urllib.error
import urllib.request

CRED = os.path.expanduser("~/.dsh/.credentials.yaml")
URL = "https://api.deepseek.com/anthropic/v1/messages"
MODEL = "deepseek-flash"

CITIES = ["Paris", "Berlin", "Rome", "Madrid", "Lisbon", "Oslo"]
TOOLS = [{"name": "get_weather", "description": "Get current weather for a city.",
          "input_schema": {"type": "object", "properties": {"city": {"type": "string"}},
                           "required": ["city"]}}]


def load_key():
    import yaml
    d = yaml.safe_load(open(CRED, encoding="utf-8"))
    v = d["refs"]["DEEPSEEK_API_KEY"]
    if isinstance(v, str) and v in (d.get("records") or {}):
        r = d["records"][v]
        v = r.get("payload") if isinstance(r, dict) else r
        if isinstance(v, dict):
            v = v.get("value") or v.get("secret") or v.get("apiKey")
    return v


def call(headers, body, timeout=180):
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers=headers, method="POST")
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:400]}
    except Exception as e:  # noqa: BLE001
        return -1, {"transport": f"{type(e).__name__}: {e}"}


def main():
    key = load_key()
    hdr = {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
    base = {"model": MODEL, "max_tokens": 900, "thinking": {"type": "enabled"},
            "output_config": {"effort": "low"}, "tools": TOOLS}
    msgs = [{"role": "user", "content": [{"type": "text", "text":
             "Get the weather for these cities one at a time, one tool call per turn, "
             "in order: " + ", ".join(CITIES) + ". Keep reasoning short."}]}]

    print(f"{'轮':<4}{'HTTP':<6}{'原始thinking字符':<18}{'替换后字符':<12}{'cache_read':<12}{'下一步'}")
    for turn in range(1, len(CITIES) + 2):
        st, resp = call(hdr, {**base, "messages": msgs})
        if st != 200:
            print(f"{turn:<4}{st:<6}{'':<18}{'':<12}{'':<12}ERROR {json.dumps(resp, ensure_ascii=False)[:200]}")
            return
        blocks = resp.get("content") or []
        think = next((b for b in blocks if b.get("type") == "thinking"), None)
        callb = next((b for b in blocks if b.get("type") == "tool_use"), None)
        txt = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        usage = resp.get("usage") or {}
        cache = usage.get("cache_read_input_tokens", usage.get("cache_read", "-"))

        # —— 插件的核心动作：把 thinking 换成更短的"蒸馏版"再回传 ——
        rewritten = None
        if think is not None:
            if callb is not None:
                rewritten = f"Decision: call {callb['name']}({json.dumps(callb['input'], ensure_ascii=False)})."
            else:
                rewritten = "Decision: the tool results are sufficient; give the final answer."
        asst_content = []
        if rewritten is not None:
            asst_content.append({"type": "thinking", "thinking": rewritten})   # 不带 signature
        if callb is not None:
            asst_content.append({"type": "tool_use", "id": callb["id"], "name": callb["name"], "input": callb["input"]})
        if txt:
            asst_content.append({"type": "text", "text": txt})
        if not asst_content:
            asst_content = [{"type": "text", "text": ""}]

        print(f"{turn:<4}{st:<6}{(len(think['thinking']) if think else 0):<18}"
              f"{(len(rewritten) if rewritten else 0):<12}{str(cache):<12}"
              f"{('tool:' + callb['name'] + '(' + json.dumps(callb.get('input'), ensure_ascii=False) + ')') if callb else 'final text'}")
        msgs.append({"role": "assistant", "content": asst_content})
        if callb is None:
            break
        msgs.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": callb["id"],
                      "content": [{"type": "text", "text": "Sunny, 22C"}]}]})

    print(f"\n全部 {turn} 跳完成，历史中累计替换 thinking {turn} 次（均不带 signature）。")


if __name__ == "__main__":
    main()
