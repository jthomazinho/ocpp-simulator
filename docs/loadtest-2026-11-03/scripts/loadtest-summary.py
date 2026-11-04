#!/usr/bin/env python3
"""Summarises one load-test tier directory (loadgen.jsonl, metrics.jsonl, events.jsonl).

usage: loadtest-summary.py <tier-dir> [--json]
Steady state = samples from 30 s after "ramp done" until "restart gateway".
"""
import datetime as dt
import json
import re
import statistics
import sys
from pathlib import Path


def load(path):
    rows = []
    if path.exists():
        for line in path.read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def mib(text):
    m = re.match(r"([\d.]+)\s*([KMG]i?B)", text or "")
    if not m:
        return 0.0
    v, u = float(m.group(1)), m.group(2)
    return v * {"KiB": 1 / 1024, "MiB": 1, "GiB": 1024, "kB": 1 / 1000, "MB": 1, "GB": 1000}.get(u, 1)


def ts(iso):
    return dt.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc).timestamp()


def summarise(d: Path):
    gen_all = load(d / "loadgen.jsonl")
    gen = [r for r in gen_all if r.get("ev") == "stats"]
    inbound = [r for r in gen_all if r.get("ev") == "inbound"]
    txev = [r for r in gen_all if r.get("ev") == "tx"]
    events = load(d / "events.jsonl")
    metrics = load(d / "metrics.jsonl")
    notes = [e for e in events if e.get("ev") == "note"]
    cmds = [e for e in events if e.get("ev") == "cmd"]
    note_at = lambda prefix: next((n["at"] for n in notes if n["msg"].startswith(prefix)), None)
    t_start, t_ramp, t_restart = note_at("start"), note_at("ramp done"), note_at("restart gateway")

    out = {"tier": d.name, "notes": [n["msg"] for n in notes]}
    if gen:
        rel = lambda r: t_start / 1000 + r["t"]
        steady = [r for r in gen if t_ramp and t_restart and t_ramp / 1000 + 30 <= rel(r) <= t_restart / 1000]
        last = gen[-1]
        out["generator"] = {
            "connected_end": last["connected"],
            "boot_accepted": last["bootAccepted"],
            "boot_p95_ms": last["bootP95"],
            "disconnects_total": last["disconnects"],
            "disconnects_before_restart": max((r["disconnects"] for r in gen if not t_restart or rel(r) <= t_restart / 1000), default=0),
            "steady_call_p50_ms": round(statistics.median([r["callP50"] for r in steady if r["callP50"] is not None]), 1) if steady else None,
            "steady_call_p95_ms": round(statistics.median([r["callP95"] for r in steady if r["callP95"] is not None]), 1) if steady else None,
            "ramp_call_p95_ms_max": max((r["callP95"] or 0 for r in gen if t_ramp and rel(r) <= t_ramp / 1000 + 10), default=None),
            "in_tx_steady": steady[-1]["inTx"] if steady else None,
            "registered_steady_min": min((r.get("registered", 0) for r in steady), default=None),
            "tx_failed": last.get("txFailed"),
            "errors": last["errors"],
            "gen_rss_mb": max(r["rssMb"] for r in gen),
        }

    lat = []
    for c in cmds:
        arrive = next((i["at"] for i in inbound if i["station"] == c["station"] and i["at"] >= c["sentAt"]), None)
        kind = "started" if "Start" in c["action"] or "start" in c["action"] else "stopped"
        effect = next((t["at"] for t in txev if t["station"] == c["station"] and t["kind"] == kind and t["at"] >= c["sentAt"]), None)
        lat.append({
            "version": c["version"], "action": c["action"],
            "arrive_ms": arrive - c["sentAt"] if arrive else None,
            "effect_ms": effect - c["sentAt"] if effect else None,
        })
    out["commands"] = lat
    # Coverage per command type: a tier without an effective 1.6 RemoteStop
    # is flagged instead of passing silently (cross-review 03/11).
    out["command_coverage"] = {
        f'{c["version"]} {c["action"]}': sum(1 for x in lat if x["action"] == c["action"] and x["effect_ms"] is not None)
        for c in lat
    }
    out["remote_stop_ocpp16_measured"] = out["command_coverage"].get("1.6 remoteStopTransaction", 0) > 0

    st = [m for m in metrics if t_ramp and t_restart and t_ramp / 1000 + 30 <= ts(m["at"]) <= t_restart / 1000]
    res = {}
    for svc in ("citrineos", "postgres", "amqp-broker", "csms-backend"):
        cpu = [float(x["cpu"].rstrip("%")) for m in st for x in m.get("stats", []) if svc in x["n"]]
        mem = [mib(x["mem"]) for m in st for x in m.get("stats", []) if svc in x["n"]]
        cpu_all = [float(x["cpu"].rstrip("%")) for m in metrics for x in m.get("stats", []) if svc in x["n"]]
        res[svc] = {
            "cpu_pct_steady_avg": round(sum(cpu) / len(cpu), 1) if cpu else None,
            "cpu_pct_peak": max(cpu_all, default=None),
            "mem_mb_steady_max": round(max(mem)) if mem else None,
        }
    out["resources"] = res
    out["stack_mem_mb_peak"] = round(max((sum(mib(x["mem"]) for x in m.get("stats", [])) for m in metrics), default=0))
    conns = lambda m: sum(int(n) for n in re.findall(r":(\d+)(?=\s|$)", m.get("pg", "")))
    out["postgres"] = {
        "connections_peak": max((conns(m) for m in metrics), default=None),
        "steady_qps_avg": round(statistics.mean([m["pgq"]["qps"] for m in st if m.get("pgq")]), 1) if st else None,
        "steady_mean_stmt_ms": round(statistics.mean([m["pgq"]["meanMs"] for m in st if m.get("pgq")]), 3) if st else None,
        "peak_mean_stmt_ms": max((m["pgq"]["meanMs"] for m in metrics if m.get("pgq")), default=None),
        "worst_statement_mean_ms": max((m["pgq"]["worstStmtMeanMs"] for m in metrics if m.get("pgq")), default=None),
    }
    mq = [m["mq"] for m in st if m.get("mq")]
    mq_all = [m["mq"] for m in metrics if m.get("mq")]
    out["rabbitmq"] = {
        "steady_publish_per_s": round(statistics.mean([x.get("publishPerS", 0) for x in mq]), 1) if mq else None,
        "steady_deliver_per_s": round(statistics.mean([x.get("deliverPerS", 0) for x in mq]), 1) if mq else None,
        "queued_peak": max((x.get("queued", 0) for x in mq_all), default=None),
        "publish_per_s_peak": max((x.get("publishPerS", 0) for x in mq_all), default=None),
    }
    return out


if __name__ == "__main__":
    print(json.dumps(summarise(Path(sys.argv[1])), indent=1, ensure_ascii=False))
