#!/usr/bin/env python3
"""Realtime Android app CPU/memory watcher over adb.

Features:
- configurable sample interval
- terminal dashboard with rolling trends
- CSV archival for later analysis
- fast RSS sampling every tick
- optional PSS sampling on a slower cadence via dumpsys meminfo
"""

from __future__ import annotations

import argparse
import csv
import curses
import datetime as dt
import html
import http.server
import json
import mimetypes
import re
import shlex
import signal
import subprocess
import sys
import threading
import time
import tempfile
import webbrowser
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Deque, Iterable, List, Optional, Sequence


SPARK_CHARS = " .:-=+*#%@"
FAVICON_DATA_URL = (
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E"
    "%3Crect width='64' height='64' rx='16' fill='%2309101c'/%3E"
    "%3Cpath d='M16 44h8V28h-8zm12 0h8V18h-8zm12 0h8V34h-8z' fill='%238fb8ff'/%3E"
    "%3Cpath d='M14 38c6-10 10-10 16-2s10 8 20-8' fill='none' stroke='%2340c4aa' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/%3E"
    "%3C/svg%3E"
)
STAT_RE = re.compile(r"^(?P<pid>\d+)\s+\((?P<comm>.*)\)\s+(?P<rest>.+)$")
MEMINFO_TOTAL_PSS_RE = re.compile(r"TOTAL PSS:\s+(\d+)")
MEMINFO_APP_SUMMARY_LINE_RE = re.compile(r"^\s*([A-Za-z0-9 .()/+-]+):")
MEMINFO_OBJECT_PAIR_RE = re.compile(r"([A-Za-z][A-Za-z0-9 ]*[A-Za-z0-9]):\s+(\d+)")
BREAKDOWN_LABEL_ORDER = [
    "java_heap",
    "native_heap",
    "graphics",
    "stack",
    "code",
    "private_other",
    "system",
    "unknown",
    "dalvik_heap",
    "dalvik_other",
    "egl_mtrack",
    "gl_mtrack",
]
BREAKDOWN_LABELS = {
    "java_heap": "Java Heap",
    "native_heap": "Native Heap",
    "graphics": "Graphics",
    "stack": "Stack",
    "code": "Code",
    "private_other": "Private Other",
    "system": "System",
    "unknown": "Unknown",
    "dalvik_heap": "Dalvik Heap",
    "dalvik_other": "Dalvik Other",
    "egl_mtrack": "EGL mtrack",
    "gl_mtrack": "GL mtrack",
}


@dataclass
class ProcessTimes:
    pid: int
    utime: int
    stime: int

    @property
    def total(self) -> int:
        return self.utime + self.stime


@dataclass
class Snapshot:
    timestamp: float
    total_cpu: int
    idle_cpu: int
    process_times: List[ProcessTimes]
    top_cpu_pct: Optional[float]
    cpu_source: str
    rss_kb: int
    pss_kb: Optional[int]
    pss_breakdown_kb: dict[str, int]
    meminfo_objects: dict[str, int]
    pids: List[int]


@dataclass
class Sample:
    timestamp: float
    package: str
    pid_count: int
    pids: List[int]
    app_cpu_pct: Optional[float]
    total_cpu_pct: Optional[float]
    rss_mb: float
    pss_mb: Optional[float]
    pss_breakdown_mb: dict[str, float]
    java_heap_mb: Optional[float]
    native_heap_mb: Optional[float]
    meminfo_objects: dict[str, int]
    activities: Optional[int]
    view_root_impl: Optional[int]
    activity_gap: Optional[int]
    status: str
    cpu_source: str
    note: str = ""
    leak_status: str = "disabled"
    leak_reasons: list[str] = field(default_factory=list)
    leak_struct_state: str = "struct-normal"
    leak_watermark_state: str = "watermark-normal"
    dump_hprof_path: str = ""
    dump_manifest_path: str = ""
    dump_type: str = ""

    def to_dict(self) -> dict:
        top_pss_component = top_breakdown_entry(self.pss_breakdown_mb)
        return {
            "timestamp": round(self.timestamp, 3),
            "timestamp_iso": dt.datetime.fromtimestamp(self.timestamp).isoformat(),
            "package": self.package,
            "pid_count": self.pid_count,
            "pids": self.pids,
            "app_cpu_pct": round_or_none(self.app_cpu_pct),
            "total_cpu_pct": round_or_none(self.total_cpu_pct),
            "rss_mb": round(self.rss_mb, 2),
            "pss_mb": round_or_none(self.pss_mb),
            "pss_breakdown_mb": {key: round(value, 2) for key, value in self.pss_breakdown_mb.items()},
            "java_heap_mb": round_or_none(self.java_heap_mb),
            "native_heap_mb": round_or_none(self.native_heap_mb),
            "meminfo_objects": self.meminfo_objects,
            "activities": self.activities,
            "view_root_impl": self.view_root_impl,
            "activity_gap": self.activity_gap,
            "top_pss_component": top_pss_component,
            "status": self.status,
            "cpu_source": self.cpu_source,
            "note": self.note,
            "leak_status": self.leak_status,
            "leak_reasons": self.leak_reasons,
            "leak_struct_state": self.leak_struct_state,
            "leak_watermark_state": self.leak_watermark_state,
            "dump_hprof_path": self.dump_hprof_path,
            "dump_manifest_path": self.dump_manifest_path,
            "dump_type": self.dump_type,
        }


class AdbError(RuntimeError):
    pass


class AdbClient:
    def __init__(self, serial: Optional[str] = None) -> None:
        self.serial = serial
        self._capability_cache: dict[tuple[str, str, str], dict[str, object]] = {}
        self._device_identity = ""

    def _base_cmd(self) -> List[str]:
        cmd = ["adb"]
        if self.serial:
            cmd.extend(["-s", self.serial])
        return cmd

    def shell(self, command: str, check: bool = True) -> str:
        proc = subprocess.run(
            self._base_cmd() + ["shell", command],
            capture_output=True,
            text=True,
        )
        if check and proc.returncode != 0:
            raise AdbError(proc.stderr.strip() or proc.stdout.strip() or command)
        return proc.stdout

    def _transport_serial(self) -> str:
        proc = subprocess.run(
            self._base_cmd() + ["get-serialno"],
            capture_output=True,
            text=True,
        )
        serial = (proc.stdout or proc.stderr).strip()
        if proc.returncode != 0 or not serial or serial.lower() in {"unknown", "<unknown>"}:
            return self.serial or ""
        return serial

    def sync_device_identity(self) -> tuple[bool, dict[str, str]]:
        serial = self._transport_serial()
        manufacturer = self.shell("getprop ro.product.manufacturer", check=False).strip()
        model = self.shell("getprop ro.product.model", check=False).strip()
        device = self.shell("getprop ro.product.device", check=False).strip()
        release = self.shell("getprop ro.build.version.release", check=False).strip()
        sdk = self.shell("getprop ro.build.version.sdk", check=False).strip()
        fingerprint = self.shell("getprop ro.build.fingerprint", check=False).strip()
        model_parts = [part for part in (manufacturer, model) if part]
        model_text = " ".join(model_parts).strip() or device or "-"
        android_bits = []
        if release:
            android_bits.append(f"Android {release}")
        if sdk:
            android_bits.append(f"API {sdk}")
        info = {
            "model": model_text,
            "device": device or "-",
            "android": " / ".join(android_bits) if android_bits else "-",
            "serial": serial or self.serial or "default",
        }
        identity = "|".join(
            [
                info["serial"],
                info["model"],
                info["device"],
                info["android"],
                fingerprint,
            ]
        ).strip("|")
        changed = bool(identity and self._device_identity and identity != self._device_identity)
        if identity and identity != self._device_identity:
            self._device_identity = identity
            self._capability_cache.clear()
        return changed, info

    def ensure_device(self) -> None:
        _, info = self.sync_device_identity()
        output = info.get("model", "").strip()
        if not output:
            raise AdbError("no adb device available")

    def java_heap_growth_limit_mb(self) -> Optional[float]:
        raw = self.shell("getprop dalvik.vm.heapgrowthlimit", check=False).strip()
        if not raw:
            return None
        match = re.fullmatch(r"(?P<value>\d+(?:\.\d+)?)(?P<unit>[kKmMgG]?)", raw)
        if not match:
            return None
        value = float(match.group("value"))
        unit = match.group("unit").lower()
        if unit == "g":
            return value * 1024.0
        if unit == "k":
            return value / 1024.0
        return value

    def device_info(self) -> dict[str, str]:
        _, info = self.sync_device_identity()
        return info

    def pull(self, remote_path: str, local_path: Path) -> None:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run(
            self._base_cmd() + ["pull", remote_path, str(local_path)],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            raise AdbError(proc.stderr.strip() or proc.stdout.strip() or f"adb pull {remote_path}")

    def _resolve_installed_apk_path(self, package: str) -> Optional[str]:
        output = self.shell(f"pm path {package}", check=False).strip()
        for line in output.splitlines():
            if line.startswith("package:"):
                return line.split("package:", 1)[1].strip()
        return None

    def _host_aapt_path(self) -> Optional[Path]:
        sdk_root = Path.home() / "Android" / "Sdk" / "build-tools"
        if not sdk_root.exists():
            return None
        candidates = sorted((path / "aapt" for path in sdk_root.iterdir() if (path / "aapt").exists()), reverse=True)
        return candidates[0] if candidates else None

    def _detect_root_available(self) -> bool:
        su_path = self.shell("command -v su 2>/dev/null || which su 2>/dev/null", check=False).strip()
        if not su_path:
            return False
        su_check = self.shell("su -c id 2>/dev/null", check=False).strip()
        return "uid=0" in su_check or bool(su_path)

    def _inspect_profileable_from_apk(self, package: str) -> Optional[bool]:
        remote_apk = self._resolve_installed_apk_path(package)
        aapt_path = self._host_aapt_path()
        if not remote_apk or aapt_path is None:
            return None
        local_apk = Path(tempfile.gettempdir()) / f"perfsight_{package.replace('.', '_')}.apk"
        try:
            try:
                self.pull(remote_apk, local_apk)
            except AdbError:
                return None
            proc = subprocess.run(
                [str(aapt_path), "dump", "xmltree", str(local_apk), "AndroidManifest.xml"],
                capture_output=True,
                text=True,
            )
            if proc.returncode != 0:
                return None
            manifest_dump = proc.stdout
            return bool(re.search(r"^\s*E:\s+profileable\b", manifest_dump, re.IGNORECASE | re.MULTILINE))
        finally:
            if local_apk.exists():
                local_apk.unlink()

    @staticmethod
    def is_device_unavailable_error(message: str) -> bool:
        lowered = message.lower()
        markers = (
            "no adb device available",
            "no devices/emulators found",
            "device offline",
            "device not found",
            "more than one device/emulator",
            "error: no devices/emulators found",
            "cannot connect to daemon",
            "failed to get feature set",
            "closed",
        )
        return any(marker in lowered for marker in markers)

    def package_capabilities(self, package: str) -> dict[str, object]:
        self.sync_device_identity()
        output = self.shell(f"dumpsys package {package}", check=False)
        rooted = self._detect_root_available()
        if not output.strip():
            return {
                "debuggable": False,
                "profileable": False,
                "rooted": rooted,
                "dump_reason": "unable to query package info",
            }
        debuggable_patterns = (
            r"\bdebuggable=true\b",
            r"\bpkgFlags=\[[^\]]*\bDEBUGGABLE\b",
            r"\bflags=\[[^\]]*\bDEBUGGABLE\b",
            r"\bprivateFlags=\[[^\]]*\bDEBUGGABLE\b",
        )
        profileable_patterns = (
            r"\bprofileable=true\b",
            r"\bprofileableByShell=true\b",
            r"\bprofileablebyshell=true\b",
        )
        code_path = next((line.split("=", 1)[1].strip() for line in output.splitlines() if "codePath=" in line), "")
        last_update_time = next((line.split("=", 1)[1].strip() for line in output.splitlines() if "lastUpdateTime=" in line), "")
        cache_key = (package, code_path, last_update_time)
        cached = self._capability_cache.get(cache_key)
        if cached is not None:
            return dict(cached)
        debuggable = any(re.search(pattern, output, re.IGNORECASE) for pattern in debuggable_patterns)
        profileable = any(re.search(pattern, output, re.IGNORECASE) for pattern in profileable_patterns)
        if not profileable:
            manifest_profileable = self._inspect_profileable_from_apk(package)
            if manifest_profileable is not None:
                profileable = manifest_profileable
        if debuggable:
            profileable = True
        if debuggable:
            dump_reason = "package is debuggable"
        elif rooted:
            dump_reason = "root device available"
        else:
            dump_reason = "package is not debuggable and device is not rooted"
        capabilities = {
            "debuggable": debuggable,
            "profileable": profileable,
            "rooted": rooted,
            "dump_reason": dump_reason,
        }
        self._capability_cache[cache_key] = dict(capabilities)
        return capabilities


class PackageCollector:
    def __init__(self, adb: AdbClient, package: str, pss_interval: float) -> None:
        self.adb = adb
        self.package = package
        self.pss_interval = max(0.0, pss_interval)
        self._last_pss_at = 0.0
        self._last_pss_kb: Optional[int] = None
        self._last_pss_breakdown_kb: dict[str, int] = {}
        self._last_meminfo_objects: dict[str, int] = {}

    def reset_runtime_cache(self) -> None:
        self._last_pss_at = 0.0
        self._last_pss_kb = None
        self._last_pss_breakdown_kb = {}
        self._last_meminfo_objects = {}

    def snapshot(self) -> Snapshot:
        pids = self._get_pids()
        if not pids:
            return Snapshot(
                timestamp=time.time(),
                total_cpu=self._read_total_cpu(),
                idle_cpu=self._read_idle_cpu(),
                process_times=[],
                top_cpu_pct=None,
                cpu_source="unavailable",
                rss_kb=0,
                pss_kb=None,
                pss_breakdown_kb={},
                meminfo_objects={},
                pids=[],
            )

        total_cpu, idle_cpu = self._read_cpu_totals()
        process_times = self._read_process_times(pids)
        top_cpu_pct = None
        cpu_source = "proc"
        if not process_times:
            top_cpu_pct = self._read_top_cpu_pct(pids)
            cpu_source = "top" if top_cpu_pct is not None else "unavailable"
        rss_kb = self._read_rss_kb(pids)
        pss_kb, pss_breakdown_kb, meminfo_objects = self._maybe_refresh_pss(force=False)
        live_pids = [p.pid for p in process_times]
        return Snapshot(
            timestamp=time.time(),
            total_cpu=total_cpu,
            idle_cpu=idle_cpu,
            process_times=process_times,
            top_cpu_pct=top_cpu_pct,
            cpu_source=cpu_source,
            rss_kb=rss_kb,
            pss_kb=pss_kb,
            pss_breakdown_kb=pss_breakdown_kb,
            meminfo_objects=meminfo_objects,
            pids=live_pids or list(pids),
        )

    def _get_pids(self) -> List[int]:
        output = self.adb.shell(f"pidof {self.package}", check=False).strip()
        if output:
            candidate_pids = [int(pid) for pid in output.split() if pid.isdigit()]
            main_pids = self._filter_main_process_pids(candidate_pids)
            if main_pids:
                return main_pids[:1]

        ps_output = self.adb.shell("ps -A", check=False)
        matches = []
        for line in ps_output.splitlines():
            if self.package not in line:
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            if parts[-1] != self.package:
                continue
            if parts[1].isdigit():
                matches.append(int(parts[1]))
        return matches[:1]

    def _filter_main_process_pids(self, pids: Sequence[int]) -> List[int]:
        if not pids:
            return []
        script = "; ".join(
            [f"printf '%s ' {pid}; cat /proc/{pid}/cmdline 2>/dev/null; printf '\\n'" for pid in pids]
        )
        output = self.adb.shell(script, check=False)
        result: List[int] = []
        for raw_line in output.splitlines():
            if not raw_line.strip():
                continue
            pid_text, _, cmdline_raw = raw_line.partition(" ")
            if not pid_text.isdigit():
                continue
            cmdline = cmdline_raw.replace("\x00", "").strip()
            if cmdline == self.package:
                result.append(int(pid_text))
        return sorted(result)

    def _read_cpu_totals(self) -> tuple[int, int]:
        output = self.adb.shell("cat /proc/stat | head -n 1", check=False).strip()
        if not output.startswith("cpu "):
            raise AdbError("failed to read /proc/stat")
        values = [int(part) for part in output.split()[1:] if part.isdigit()]
        if len(values) < 4:
            raise AdbError("unexpected /proc/stat format")
        idle = values[3] + (values[4] if len(values) > 4 else 0)
        return sum(values), idle

    def _read_total_cpu(self) -> int:
        total, _ = self._read_cpu_totals()
        return total

    def _read_idle_cpu(self) -> int:
        _, idle = self._read_cpu_totals()
        return idle

    def _read_process_times(self, pids: Sequence[int]) -> List[ProcessTimes]:
        script = "; ".join(
            [f"cat /proc/{pid}/stat 2>/dev/null || true" for pid in pids]
        )
        output = self.adb.shell(script, check=False)
        result: List[ProcessTimes] = []
        for line in output.splitlines():
            parsed = parse_proc_stat_line(line.strip())
            if parsed:
                result.append(parsed)
        return result

    def _read_top_cpu_pct(self, pids: Sequence[int]) -> Optional[float]:
        pid_args = " ".join(str(pid) for pid in pids)
        output = self.adb.shell(f"top -b -n 1 -p {pid_args}", check=False)
        return parse_top_cpu_pct(output, pids)

    def _read_rss_kb(self, pids: Sequence[int]) -> int:
        script = "; ".join(
            [f"cat /proc/{pid}/status 2>/dev/null | grep VmRSS || true" for pid in pids]
        )
        output = self.adb.shell(script, check=False)
        total = 0
        for line in output.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                total += int(parts[1])
        return total

    def _maybe_refresh_pss(self, force: bool) -> tuple[Optional[int], dict[str, int], dict[str, int]]:
        now = time.time()
        if not force and self.pss_interval > 0 and (now - self._last_pss_at) < self.pss_interval:
            return self._last_pss_kb, dict(self._last_pss_breakdown_kb), dict(self._last_meminfo_objects)

        output = self.adb.shell(f"dumpsys meminfo {self.package}", check=False)
        pss_kb, breakdown_kb, meminfo_objects = parse_meminfo_pss(output)
        if pss_kb is not None:
            self._last_pss_kb = pss_kb
            self._last_pss_breakdown_kb = breakdown_kb
            self._last_meminfo_objects = meminfo_objects
            self._last_pss_at = now
        elif force:
            self._last_pss_kb = None
            self._last_pss_breakdown_kb = {}
            self._last_meminfo_objects = {}
            self._last_pss_at = now
        return self._last_pss_kb, dict(self._last_pss_breakdown_kb), dict(self._last_meminfo_objects)


def parse_proc_stat_line(line: str) -> Optional[ProcessTimes]:
    match = STAT_RE.match(line)
    if not match:
        return None
    pid = int(match.group("pid"))
    rest = match.group("rest").split()
    if len(rest) < 15:
        return None
    utime = int(rest[11])
    stime = int(rest[12])
    return ProcessTimes(pid=pid, utime=utime, stime=stime)


def normalize_breakdown_label(label: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", label.strip().lower()).strip("_")
    return normalized


def percentile(values: Sequence[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = max(0.0, min(1.0, q)) * (len(ordered) - 1)
    lower = int(position)
    upper = min(len(ordered) - 1, lower + 1)
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def theil_sen_slope(points: Sequence[tuple[float, float]]) -> float:
    if len(points) < 2:
        return 0.0
    slopes: list[float] = []
    for index, (x0, y0) in enumerate(points[:-1]):
        for x1, y1 in points[index + 1:]:
            delta_x = x1 - x0
            if delta_x <= 0:
                continue
            slopes.append((y1 - y0) / delta_x)
    return percentile(slopes, 0.5) if slopes else 0.0


def ordered_breakdown_items(breakdown: dict[str, float]) -> list[tuple[str, float]]:
    def sort_key(item: tuple[str, float]) -> tuple[int, str]:
        key, _ = item
        try:
            return BREAKDOWN_LABEL_ORDER.index(key), key
        except ValueError:
            return len(BREAKDOWN_LABEL_ORDER), key

    return sorted(breakdown.items(), key=sort_key)


def top_breakdown_entry(breakdown: dict[str, float]) -> Optional[dict[str, float | str]]:
    if not breakdown:
        return None
    key, value = max(breakdown.items(), key=lambda item: item[1])
    return {"key": key, "label": BREAKDOWN_LABELS.get(key, key.replace("_", " ").title()), "value": round(value, 2)}


def parse_meminfo_objects(output: str) -> dict[str, int]:
    objects: dict[str, int] = {}
    in_objects = False
    for raw_line in output.splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()
        if stripped == "Objects":
            in_objects = True
            continue
        if not in_objects:
            continue
        if stripped and not raw_line.startswith(" "):
            break
        for match in MEMINFO_OBJECT_PAIR_RE.finditer(line):
            objects[normalize_breakdown_label(match.group(1))] = int(match.group(2))
    return objects


def parse_meminfo_pss(output: str) -> tuple[Optional[int], dict[str, int], dict[str, int]]:
    total_match = MEMINFO_TOTAL_PSS_RE.search(output)
    total_pss_kb = int(total_match.group(1)) if total_match else None
    breakdown: dict[str, int] = {}
    meminfo_objects = parse_meminfo_objects(output)
    in_app_summary = False
    for raw_line in output.splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()
        if stripped == "App Summary":
            in_app_summary = True
            continue
        if not in_app_summary:
            continue
        if stripped.startswith("Objects") or stripped.startswith("SQL"):
            break
        match = MEMINFO_APP_SUMMARY_LINE_RE.match(line)
        if not match:
            continue
        label = normalize_breakdown_label(match.group(1))
        _, tail = line.split(":", 1)
        pss_field = tail[:16].strip()
        if not pss_field.isdigit():
            continue
        value = int(pss_field)
        if label in {"total", "total_pss"}:
            total_pss_kb = value
            continue
        breakdown[label] = value
    if total_pss_kb is not None:
        known_total = sum(breakdown.values())
        if total_pss_kb > known_total and "unknown" not in breakdown:
            breakdown["unknown"] = total_pss_kb - known_total
    return total_pss_kb, breakdown, meminfo_objects


def build_sample(prev: Snapshot, curr: Snapshot, package: str) -> Sample:
    app_cpu_pct: Optional[float] = None
    total_cpu_pct: Optional[float] = None
    delta_total = curr.total_cpu - prev.total_cpu
    prev_map = {proc.pid: proc.total for proc in prev.process_times}
    curr_map = {proc.pid: proc.total for proc in curr.process_times}
    common_pids = set(prev_map) & set(curr_map)
    if delta_total > 0 and common_pids:
        delta_proc = sum(curr_map[pid] - prev_map[pid] for pid in common_pids)
        app_cpu_pct = max(0.0, 100.0 * delta_proc / delta_total)
    elif curr.top_cpu_pct is not None:
        app_cpu_pct = curr.top_cpu_pct
    if delta_total > 0:
        delta_idle = curr.idle_cpu - prev.idle_cpu
        total_cpu_pct = max(0.0, min(100.0, 100.0 * (delta_total - delta_idle) / delta_total))

    status = "running" if curr.pids else "not-running"
    note = ""
    if prev.pids and not curr.pids:
        note = "process exited"
    elif curr.pids and set(prev.pids) != set(curr.pids):
        note = "pid changed"

    return Sample(
        timestamp=curr.timestamp,
        package=package,
        pid_count=len(curr.pids),
        pids=curr.pids,
        app_cpu_pct=app_cpu_pct,
        total_cpu_pct=total_cpu_pct,
        rss_mb=curr.rss_kb / 1024.0,
        pss_mb=(curr.pss_kb / 1024.0) if curr.pss_kb is not None else None,
        pss_breakdown_mb={key: value / 1024.0 for key, value in curr.pss_breakdown_kb.items()},
        java_heap_mb=(curr.pss_breakdown_kb.get("java_heap", 0) / 1024.0) if "java_heap" in curr.pss_breakdown_kb else None,
        native_heap_mb=(curr.pss_breakdown_kb.get("native_heap", 0) / 1024.0) if "native_heap" in curr.pss_breakdown_kb else None,
        meminfo_objects=dict(curr.meminfo_objects),
        activities=curr.meminfo_objects.get("activities"),
        view_root_impl=curr.meminfo_objects.get("viewrootimpl"),
        activity_gap=(
            curr.meminfo_objects.get("activities", 0) - curr.meminfo_objects.get("viewrootimpl", 0)
            if "activities" in curr.meminfo_objects and "viewrootimpl" in curr.meminfo_objects
            else None
        ),
        status=status,
        cpu_source=curr.cpu_source,
        note=note,
    )


def parse_top_cpu_pct(output: str, pids: Sequence[int]) -> Optional[float]:
    pid_set = {str(pid) for pid in pids}
    total = 0.0
    found = False
    cpu_idx: Optional[int] = None
    for line in output.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        header_parts = stripped.split()
        if "PID" in header_parts and any("%CPU" in token or "CPU%" in token for token in header_parts):
            for idx, token in enumerate(header_parts):
                if token in ("%CPU", "CPU%", "[%CPU]"):
                    cpu_idx = idx
                    break
                if token.startswith("S[") and "%CPU" in token:
                    cpu_idx = idx + 1
                    break
                if "%CPU" in token or "CPU%" in token:
                    cpu_idx = idx
                    break
            continue
        if not any(pid in stripped for pid in pid_set):
            continue
        parts = stripped.split()
        pid_in_line = None
        if parts and parts[0] in pid_set:
            pid_in_line = parts[0]
        else:
            for part in parts:
                if part in pid_set:
                    pid_in_line = part
                    break
        if pid_in_line is None:
            continue
        candidates = []
        if cpu_idx is not None and cpu_idx < len(parts):
            candidates.append(parts[cpu_idx])
        candidates.extend(parts)
        for part in candidates:
            value = part.strip("[]").rstrip("%")
            try:
                cpu_pct = float(value)
            except ValueError:
                continue
            if 0.0 <= cpu_pct <= 1000.0:
                total += cpu_pct
                found = True
                break
    return total if found else None


@dataclass
class LeakJudgeConfig:
    enabled: bool
    warmup_sec: float
    dump_threshold_mb: float
    java_heap_max_mb: float
    java_heap_watch_ratio: float
    java_heap_dump_ratio: float
    struct_gap_suspect: int
    struct_gap_high: int
    struct_suspect_hits: int
    struct_high_hits: int
    struct_high_gap_hits: int
    struct_recover_hits: int
    cooldown_sec: float
    max_dumps_per_pid: int
    max_dumps_per_session: int
    dump_dir: Path


@dataclass
class LeakDecision:
    leak_status: str
    reasons: list[str]
    struct_state: str
    watermark_state: str
    dump_requested: bool = False


class LeakJudge:
    def __init__(self, config: LeakJudgeConfig) -> None:
        self.config = config
        self._started_at = time.time()
        self._current_pid: Optional[int] = None
        self._struct_suspect_streak = 0
        self._struct_high_streak = 0
        self._struct_gap_high_streak = 0
        self._struct_recover_streak = 0
        self._last_dump_at = 0.0
        self._dump_counts_by_pid: dict[int, int] = {}
        self._dump_count_session = 0

    def evaluate(self, sample: Sample) -> LeakDecision:
        if not self.config.enabled:
            return LeakDecision("disabled", [], "struct-normal", "watermark-normal")

        pid = sample.pids[0] if sample.pids else None
        if pid != self._current_pid:
            self._reset_for_pid(pid)

        if sample.status != "running" or pid is None:
            return LeakDecision("not-running", [], "struct-normal", "watermark-normal")

        if (sample.timestamp - self._started_at) < self.config.warmup_sec:
            return LeakDecision("warmup", [], "struct-normal", "watermark-normal")

        struct_state, struct_reasons = self._evaluate_structure(sample)
        watermark_state, watermark_reasons = self._evaluate_watermark(sample)
        reasons = struct_reasons + watermark_reasons
        leak_status = self._classify(sample, struct_state, watermark_state)
        dump_requested = self._should_dump(sample, leak_status, struct_state, watermark_state)
        return LeakDecision(leak_status, reasons, struct_state, watermark_state, dump_requested=dump_requested)

    def mark_dumped(self, sample: Sample) -> None:
        if not sample.pids:
            return
        pid = sample.pids[0]
        self._last_dump_at = sample.timestamp
        self._dump_count_session += 1
        self._dump_counts_by_pid[pid] = self._dump_counts_by_pid.get(pid, 0) + 1

    def _reset_for_pid(self, pid: Optional[int]) -> None:
        self._current_pid = pid
        self._struct_suspect_streak = 0
        self._struct_high_streak = 0
        self._struct_gap_high_streak = 0
        self._struct_recover_streak = 0
        self._started_at = time.time()

    def _evaluate_structure(self, sample: Sample) -> tuple[str, list[str]]:
        gap = sample.activity_gap
        reasons: list[str] = []
        if gap is None:
            return "struct-normal", reasons

        if gap <= 1:
            self._struct_recover_streak += 1
            if self._struct_recover_streak >= self.config.struct_recover_hits:
                self._struct_suspect_streak = 0
                self._struct_high_streak = 0
                self._struct_gap_high_streak = 0
            return "struct-normal", reasons

        self._struct_recover_streak = 0
        if gap >= self.config.struct_gap_suspect:
            self._struct_suspect_streak += 1
        else:
            self._struct_suspect_streak = 0

        if gap >= self.config.struct_gap_high:
            self._struct_gap_high_streak += 1
        else:
            self._struct_gap_high_streak = 0

        reasons.append(f"activity_gap={gap}")
        if self._struct_suspect_streak >= self.config.struct_high_hits or self._struct_gap_high_streak >= self.config.struct_high_gap_hits:
            reasons.append("struct-high-confidence")
            return "struct-high-confidence", reasons
        if self._struct_suspect_streak >= self.config.struct_suspect_hits:
            reasons.append("struct-suspected")
            return "struct-suspected", reasons
        return "struct-normal", reasons

    def _evaluate_watermark(self, sample: Sample) -> tuple[str, list[str]]:
        reasons: list[str] = []
        if sample.java_heap_mb is None or self.config.java_heap_max_mb <= 0:
            return "watermark-normal", reasons
        heap_ratio = sample.java_heap_mb / max(self.config.java_heap_max_mb, 1e-6)
        reasons.append(f"java_heap_ratio={heap_ratio:.3f}")
        reasons.append(f"java_heap_max_mb={self.config.java_heap_max_mb:.1f}")
        if heap_ratio >= self.config.java_heap_dump_ratio:
            reasons.append("watermark-high-confidence")
            return "watermark-high-confidence", reasons
        if heap_ratio >= self.config.java_heap_watch_ratio:
            reasons.append("watermark-suspected")
            return "watermark-suspected", reasons
        return "watermark-normal", reasons

    def _classify(self, sample: Sample, struct_state: str, watermark_state: str) -> str:
        if self._in_cooldown(sample.timestamp):
            return "cooldown"
        if struct_state == "struct-high-confidence":
            return "leak-suspected"
        if struct_state == "struct-suspected":
            return "watching"
        if watermark_state == "watermark-high-confidence":
            return "leak-suspected"
        if watermark_state == "watermark-suspected":
            return "watching"
        if (
            sample.pss_mb is not None
            and sample.pss_mb >= self.config.dump_threshold_mb
            and (sample.java_heap_mb is None or sample.java_heap_mb < self.config.java_heap_max_mb * self.config.java_heap_watch_ratio)
            and struct_state == "struct-normal"
        ):
            return "non-java-memory-pressure"
        return "not-leaking"

    def _should_dump(self, sample: Sample, leak_status: str, struct_state: str, watermark_state: str) -> bool:
        if self._in_cooldown(sample.timestamp):
            return False
        if self._dump_count_session >= self.config.max_dumps_per_session:
            return False
        if not sample.pids:
            return False
        pid = sample.pids[0]
        if self._dump_counts_by_pid.get(pid, 0) >= self.config.max_dumps_per_pid:
            return False
        pss_at_dump = sample.pss_mb is not None and sample.pss_mb >= self.config.dump_threshold_mb
        if struct_state == "struct-high-confidence" and pss_at_dump:
            return True
        if watermark_state == "watermark-high-confidence":
            return True
        if struct_state == "struct-suspected" and watermark_state == "watermark-suspected":
            return True
        return False

    def _in_cooldown(self, timestamp: float) -> bool:
        return self._last_dump_at > 0 and (timestamp - self._last_dump_at) < self.config.cooldown_sec


class HprofCapture:
    def __init__(self, adb: AdbClient, package: str, capture_dir: Path, use_root: bool = False) -> None:
        self.adb = adb
        self.package = package
        self.capture_dir = capture_dir
        self.use_root = use_root

    def _shell(self, command: str, check: bool = False) -> str:
        if self.use_root:
            return self.adb.shell(f"su -c {shlex.quote(command)}", check=check)
        return self.adb.shell(command, check=check)

    def _remote_file_size(self, remote_path: str) -> int:
        output = self._shell(f"wc -c < {shlex.quote(remote_path)} 2>/dev/null", check=False).strip()
        if output.isdigit():
            return int(output)
        return 0

    def _wait_for_remote_hprof(self, remote_path: str, timeout_sec: float = 30.0) -> int:
        deadline = time.monotonic() + timeout_sec
        last_size = -1
        stable_hits = 0
        while time.monotonic() < deadline:
            size = self._remote_file_size(remote_path)
            if size > 0:
                if size == last_size:
                    stable_hits += 1
                else:
                    stable_hits = 0
                if stable_hits >= 2:
                    return size
            last_size = size
            time.sleep(0.5)
        return self._remote_file_size(remote_path)

    def _leak_rule_types(self, sample: Sample, reasons: Sequence[str], dump_type: str) -> list[str]:
        if dump_type != "leak":
            return []
        rule_types: list[str] = []
        if sample.leak_struct_state != "struct-normal" or any(
            reason.startswith("struct-") or reason.startswith("activity_gap=") for reason in reasons
        ):
            rule_types.append("struct")
        if sample.leak_watermark_state != "watermark-normal" or any(
            reason.startswith("watermark-")
            or reason.startswith("java_heap_ratio=")
            or reason.startswith("java_heap_max_mb=")
            for reason in reasons
        ):
            rule_types.append("watermark")
        return rule_types

    def _primary_dump_trigger_rule(self, sample: Sample, reasons: Sequence[str], dump_type: str) -> str:
        if dump_type == "manual":
            return "manual"
        if dump_type != "leak":
            return ""
        if sample.leak_struct_state == "struct-high-confidence":
            return "struct"
        if sample.leak_watermark_state == "watermark-high-confidence":
            return "watermark"
        rule_types = self._leak_rule_types(sample, reasons, dump_type)
        return rule_types[0] if rule_types else ""

    def _primary_dump_trigger_label(self, rule: str) -> str:
        label_map = {
            "manual": "manual-trigger",
            "struct": "struct-rule",
            "watermark": "watermark-rule",
        }
        return label_map.get(rule, "")

    def capture(self, sample: Sample, reasons: Sequence[str], dump_type: str) -> tuple[str, str]:
        if not sample.pids:
            raise AdbError("no pid available for hprof dump")
        pid = sample.pids[0]
        stamp = dt.datetime.fromtimestamp(sample.timestamp).strftime("%Y%m%d_%H%M%S")
        file_stem = f"{self.package.replace('.', '_')}_{stamp}_pid{pid}"
        session_dir = self.capture_dir / self.package.replace(".", "_") / f"{stamp}_pid{pid}"
        session_dir.mkdir(parents=True, exist_ok=True)
        remote_path = f"/data/local/tmp/{file_stem}.hprof"
        local_hprof = session_dir / f"{file_stem}.hprof"
        manifest_path = session_dir / f"{file_stem}.json"
        dump_command = f"am dumpheap -g {pid} {shlex.quote(remote_path)}"
        if self.use_root:
            dump_command = f"{dump_command} && chmod 0644 {shlex.quote(remote_path)}"
        dump_output = self._shell(dump_command, check=False).strip()
        remote_size = self._wait_for_remote_hprof(remote_path)
        if remote_size <= 0:
            raise AdbError(f"hprof dump produced empty file: {remote_path}")
        self.adb.pull(remote_path, local_hprof)
        self._shell(f"rm -f {shlex.quote(remote_path)}", check=False)
        primary_trigger_rule = self._primary_dump_trigger_rule(sample, reasons, dump_type)
        manifest = {
            "package": self.package,
            "pid": pid,
            "timestamp": dt.datetime.fromtimestamp(sample.timestamp).isoformat(),
            "dump_type": dump_type,
            "primary_dump_trigger_rule": primary_trigger_rule,
            "primary_dump_trigger_label": self._primary_dump_trigger_label(primary_trigger_rule),
            "reasons": list(reasons),
            "leak_rule_types": self._leak_rule_types(sample, reasons, dump_type),
            "leak_struct_state": sample.leak_struct_state,
            "leak_watermark_state": sample.leak_watermark_state,
            "java_heap_mb": round_or_none(sample.java_heap_mb),
            "native_heap_mb": round_or_none(sample.native_heap_mb),
            "total_pss_mb": round_or_none(sample.pss_mb),
            "activities": sample.activities,
            "view_root_impl": sample.view_root_impl,
            "activity_gap": sample.activity_gap,
            "dump_output": dump_output,
            "remote_hprof_size": remote_size,
            "local_hprof_path": str(local_hprof),
        }
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        return str(local_hprof), str(manifest_path)


class LeakCaptureManager:
    def __init__(
        self,
        judge: Optional[LeakJudge],
        capture: Optional[HprofCapture],
        state: Optional["WebState"] = None,
    ) -> None:
        self.judge = judge
        self.capture = capture
        self.state = state

    def process(self, sample: Sample) -> Sample:
        if self.judge is None:
            return sample
        decision = self.judge.evaluate(sample)
        sample.leak_status = decision.leak_status
        sample.leak_reasons = list(decision.reasons)
        sample.leak_struct_state = decision.struct_state
        sample.leak_watermark_state = decision.watermark_state
        if decision.dump_requested and self.capture is not None:
            try:
                if self.state is not None:
                    hprof_path, manifest_path = self.state.execute_dump(sample, decision.reasons, "leak", self.capture)
                else:
                    hprof_path, manifest_path = self.capture.capture(sample, decision.reasons, "leak")
                sample.dump_hprof_path = hprof_path
                sample.dump_manifest_path = manifest_path
                sample.dump_type = "leak"
                sample.leak_status = "dump-triggered"
                sample.note = (sample.note + " | " if sample.note else "") + f"hprof dumped: {Path(hprof_path).name}"
                self.judge.mark_dumped(sample)
            except AdbError as exc:
                sample.note = (sample.note + " | " if sample.note else "") + f"hprof dump failed: {exc}"
        return sample


class SampleWriter:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._file = path.open("a", newline="", encoding="utf-8")
        self._writer = csv.writer(self._file)
        if self._file.tell() == 0:
            self._writer.writerow(
                [
                    "timestamp_iso",
                    "timestamp_epoch",
                    "package",
                    "pid_count",
                    "pids",
                    "app_cpu_pct",
                    "total_cpu_pct",
                    "pss_mb",
                    "pss_breakdown_json",
                    "java_heap_mb",
                    "native_heap_mb",
                    "activities",
                    "view_root_impl",
                    "activity_gap",
                    "status",
                    "cpu_source",
                    "leak_status",
                    "leak_reasons",
                    "leak_struct_state",
                    "leak_watermark_state",
                    "dump_hprof_path",
                    "dump_manifest_path",
                    "dump_type",
                    "note",
                ]
            )
            self._file.flush()

    def write(self, sample: Sample) -> None:
        timestamp_iso = dt.datetime.fromtimestamp(sample.timestamp).isoformat()
        self._writer.writerow(
            [
                timestamp_iso,
                f"{sample.timestamp:.3f}",
                sample.package,
                sample.pid_count,
                " ".join(str(pid) for pid in sample.pids),
                fmt_float(sample.app_cpu_pct),
                fmt_float(sample.total_cpu_pct),
                fmt_float(sample.pss_mb),
                json.dumps({key: round(value, 2) for key, value in sample.pss_breakdown_mb.items()}, ensure_ascii=False),
                fmt_float(sample.java_heap_mb),
                fmt_float(sample.native_heap_mb),
                sample.activities if sample.activities is not None else "",
                sample.view_root_impl if sample.view_root_impl is not None else "",
                sample.activity_gap if sample.activity_gap is not None else "",
                sample.status,
                sample.cpu_source,
                sample.leak_status,
                json.dumps(sample.leak_reasons, ensure_ascii=False),
                sample.leak_struct_state,
                sample.leak_watermark_state,
                sample.dump_hprof_path,
                sample.dump_manifest_path,
                sample.dump_type,
                sample.note,
            ]
        )
        self._file.flush()

    def close(self) -> None:
        self._file.close()


class SampleStore:
    def __init__(self, maxlen: int) -> None:
        self._samples: Deque[Sample] = deque(maxlen=maxlen)
        self._lock = threading.Lock()

    def add(self, sample: Sample) -> None:
        with self._lock:
            self._samples.append(sample)

    def snapshot(self) -> List[Sample]:
        with self._lock:
            return list(self._samples)

    def latest(self) -> Optional[Sample]:
        with self._lock:
            return self._samples[-1] if self._samples else None

    def clear(self) -> None:
        with self._lock:
            self._samples.clear()


class Dashboard:
    def __init__(
        self,
        package: str,
        interval: float,
        history_size: int,
        csv_path: Path,
        sample_store: Optional[SampleStore] = None,
    ) -> None:
        self.package = package
        self.interval = interval
        self.history_size = history_size
        self.csv_path = csv_path
        self.sample_store = sample_store or SampleStore(history_size)
        self._screen = None

    def add(self, sample: Sample) -> None:
        self.sample_store.add(sample)

    def run(self, loop) -> None:
        curses.wrapper(self._curses_main, loop)

    def _curses_main(self, stdscr, loop) -> None:
        self._screen = stdscr
        curses.curs_set(0)
        stdscr.nodelay(True)
        stdscr.timeout(100)
        loop(stdscr)

    def draw(self, stdscr) -> None:
        stdscr.erase()
        height, width = stdscr.getmaxyx()
        now = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        samples = self.sample_store.snapshot()
        latest = samples[-1] if samples else None
        stdscr.addnstr(0, 0, f"ADB App Perf Watch | {self.package} | {now}", width - 1)
        stdscr.addnstr(
            1,
            0,
            f"interval={self.interval:.2f}s history={self.history_size} output={self.csv_path}",
            width - 1,
        )
        stdscr.addnstr(2, 0, "press q to quit", width - 1)

        if latest is None:
            stdscr.addnstr(4, 0, "waiting for first sample...", width - 1)
            stdscr.refresh()
            return

        stdscr.addnstr(
            4,
            0,
            (
                f"status={latest.status} pid_count={latest.pid_count} pids={join_pids(latest.pids)} "
                f"cpu={fmt_metric(latest.app_cpu_pct, '%')} pss={fmt_metric(latest.pss_mb, 'MB')} "
                f"java={fmt_metric(latest.java_heap_mb, 'MB')} gap={latest.activity_gap if latest.activity_gap is not None else '-'} "
                f"leak={latest.leak_status} top={format_top_component(latest.pss_breakdown_mb)} "
                f"cpu_src={latest.cpu_source} note={latest.note or '-'}"
            ),
            width - 1,
        )
        stdscr.addnstr(6, 0, "cpu trend", width - 1)
        stdscr.addnstr(
            7,
            0,
            render_series([sample.app_cpu_pct for sample in samples], width - 1, max_value=100.0),
            width - 1,
        )
        stdscr.addnstr(9, 0, "total pss trend", width - 1)
        stdscr.addnstr(
            10,
            0,
            render_series([sample.pss_mb for sample in samples], width - 1, max_value=None),
            width - 1,
        )

        table_top = 12
        stdscr.addnstr(table_top, 0, "recent samples", width - 1)
        row = table_top + 1
        headers = "time       cpu      pss_mb   top_component         source   status"
        stdscr.addnstr(row, 0, headers, width - 1)
        row += 1
        for sample in samples[-max(0, height - row - 1):][::-1]:
            ts = dt.datetime.fromtimestamp(sample.timestamp).strftime("%H:%M:%S")
            line = (
                f"{ts:<10} "
                f"{fmt_metric(sample.app_cpu_pct, '%', width=7):<8} "
                f"{fmt_metric(sample.pss_mb, '', width=7):<8} "
                f"{format_top_component(sample.pss_breakdown_mb, width=21):<21} "
                f"{sample.cpu_source:<8} "
                f"{sample.status}"
            )
            stdscr.addnstr(row, 0, line, width - 1)
            row += 1
            if row >= height:
                break
        stdscr.refresh()


class WebState:
    def __init__(
        self,
        package: str,
        interval: float,
        csv_path: Path,
        meta_path: Path,
        sample_store: SampleStore,
        capture: Optional[HprofCapture] = None,
        dump_reason: str = "",
        debuggable: bool = False,
        profileable: bool = False,
        rooted: bool = False,
        device_info: Optional[dict[str, str]] = None,
        app_max_java_heap_mb: Optional[float] = None,
    ) -> None:
        self.package = package
        self.interval = interval
        self.csv_path = csv_path
        self.meta_path = meta_path
        self.sample_store = sample_store
        self.started_at = dt.datetime.now().isoformat()
        self.capture = capture
        self.dump_reason = dump_reason
        self.debuggable = debuggable
        self.profileable = profileable
        self.rooted = rooted
        self.device_info = dict(device_info or {})
        self.app_max_java_heap_mb = app_max_java_heap_mb
        self.app_session_id = 0
        self._active_pid: Optional[int] = None
        self.connection_status = "connected"
        self.connection_note = ""
        self._dump_lock = threading.Lock()
        self.dump_in_progress = False
        self.dump_in_progress_type = ""
        self.dump_in_progress_message = ""
        self.last_dump_event: Optional[dict] = None
        self.dump_history: list[dict] = []
        self._next_dump_id = 1

    def payload(self) -> dict:
        samples = self.sample_store.snapshot()
        latest = samples[-1] if samples else None
        return {
            "package": self.package,
            "interval_sec": self.interval,
            "started_at": self.started_at,
            "csv_path": str(self.csv_path),
            "meta_path": str(self.meta_path),
            "latest": latest.to_dict() if latest else None,
            "samples": [sample.to_dict() for sample in samples],
            "last_dump_event": self.last_dump_event,
            "dump_history": list(reversed(self.dump_history)),
            "manual_dump_enabled": self.capture is not None,
            "manual_dump_reason": self.dump_reason,
            "debuggable": self.debuggable,
            "profileable": self.profileable,
            "rooted": self.rooted,
            "device_info": dict(self.device_info),
            "app_max_java_heap_mb": round_or_none(self.app_max_java_heap_mb),
            "app_session_id": self.app_session_id,
            "connection_status": self.connection_status,
            "connection_note": self.connection_note,
            "dump_in_progress": self.dump_in_progress,
            "dump_in_progress_type": self.dump_in_progress_type,
            "dump_in_progress_message": self.dump_in_progress_message,
        }

    def sync_app_session(self, sample: Sample) -> None:
        pid = sample.pids[0] if sample.status == "running" and sample.pids else None
        if pid == self._active_pid:
            return
        self._active_pid = pid
        if pid is not None:
            self.app_session_id += 1
        self.last_dump_event = None

    def set_connection_state(self, status: str, note: str = "") -> None:
        self.connection_status = status
        self.connection_note = note

    def reset_for_device_change(self, note: str = "") -> None:
        self.sample_store.clear()
        self._active_pid = None
        self.last_dump_event = None
        self.dump_history = []
        self._next_dump_id = 1
        self.app_session_id += 1
        self.connection_note = note
        self._set_dump_progress(False)

    def _set_dump_progress(self, active: bool, dump_type: str = "", message: str = "") -> None:
        self.dump_in_progress = active
        self.dump_in_progress_type = dump_type if active else ""
        self.dump_in_progress_message = message if active else ""

    def execute_dump(
        self,
        sample: Sample,
        reasons: Sequence[str],
        dump_type: str,
        capture: Optional[HprofCapture] = None,
    ) -> tuple[str, str]:
        capture_impl = capture or self.capture
        if capture_impl is None:
            raise AdbError(self.dump_reason or "manual dump unavailable")
        message = "manual HPROF capture in progress" if dump_type == "manual" else "leak-triggered HPROF capture in progress"
        with self._dump_lock:
            self._set_dump_progress(True, dump_type, message)
            try:
                return capture_impl.capture(sample, reasons, dump_type)
            finally:
                self._set_dump_progress(False)

    def _record_dump_event(self, sample: Sample, dump_type: str, hprof_path: str, manifest_path: str) -> dict:
        event = {
            "id": self._next_dump_id,
            "app_session_id": self.app_session_id,
            "timestamp": round(sample.timestamp, 3),
            "timestamp_iso": dt.datetime.fromtimestamp(sample.timestamp).isoformat(),
            "package": sample.package,
            "pid": sample.pids[0] if sample.pids else None,
            "dump_type": dump_type,
            "dump_hprof_path": hprof_path,
            "dump_manifest_path": manifest_path,
            "dump_hprof_name": Path(hprof_path).name,
            "dump_manifest_name": Path(manifest_path).name,
            "java_heap_mb": round_or_none(sample.java_heap_mb),
            "native_heap_mb": round_or_none(sample.native_heap_mb),
            "pss_mb": round_or_none(sample.pss_mb),
            "hprof_download_url": f"/downloads/{self._next_dump_id}/hprof",
            "manifest_download_url": f"/downloads/{self._next_dump_id}/manifest",
        }
        self._next_dump_id += 1
        self.last_dump_event = event
        self.dump_history.append(event)
        return event

    def record_dump_from_sample(self, sample: Sample) -> None:
        if not sample.dump_hprof_path or not sample.dump_manifest_path:
            return
        existing = next((event for event in self.dump_history if event["dump_manifest_path"] == sample.dump_manifest_path), None)
        if existing:
            self.last_dump_event = existing
            return
        dump_type = sample.dump_type or "leak"
        self._record_dump_event(sample, dump_type, sample.dump_hprof_path, sample.dump_manifest_path)

    def trigger_manual_dump(self) -> dict:
        if self.capture is None:
            raise AdbError(self.dump_reason or "manual dump unavailable")
        sample = self.sample_store.latest()
        if sample is None or not sample.pids:
            raise AdbError("no running main process available")
        hprof_path, manifest_path = self.execute_dump(sample, ["manual-trigger"], "manual", self.capture)
        sample.dump_hprof_path = hprof_path
        sample.dump_manifest_path = manifest_path
        sample.dump_type = "manual"
        sample.note = (sample.note + " | " if sample.note else "") + f"manual hprof dumped: {Path(hprof_path).name}"
        return self._record_dump_event(sample, "manual", hprof_path, manifest_path)

    def find_dump_event(self, dump_id: int) -> Optional[dict]:
        return next((event for event in self.dump_history if event["id"] == dump_id), None)


class PerfHttpServer(http.server.ThreadingHTTPServer):
    def __init__(self, server_address, request_handler_class, state: WebState):
        super().__init__(server_address, request_handler_class)
        self.state = state


class PerfRequestHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path in ("/", "/index.html"):
            body = render_html_page(self.server.state)  # type: ignore[attr-defined]
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))
            return

        if self.path == "/api/state":
            payload = json.dumps(self.server.state.payload()).encode("utf-8")  # type: ignore[attr-defined]
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
            return

        if self.path.startswith("/downloads/"):
            parts = self.path.strip("/").split("/")
            if len(parts) == 3 and parts[0] == "downloads" and parts[1].isdigit():
                dump_id = int(parts[1])
                artifact = parts[2]
                event = self.server.state.find_dump_event(dump_id)  # type: ignore[attr-defined]
                if event is None:
                    self.send_response(404)
                    self.send_header("Content-Type", "text/plain; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(b"dump not found")
                    return
                if artifact == "hprof":
                    file_path = Path(event["dump_hprof_path"])
                elif artifact == "manifest":
                    file_path = Path(event["dump_manifest_path"])
                else:
                    file_path = None
                if file_path is None or not file_path.exists():
                    self.send_response(404)
                    self.send_header("Content-Type", "text/plain; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(b"file not found")
                    return
                content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(file_path.stat().st_size))
                self.send_header("Content-Disposition", f'attachment; filename="{file_path.name}"')
                self.end_headers()
                with file_path.open("rb") as handle:
                    self.wfile.write(handle.read())
                return

        self.send_response(404)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"not found")

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/api/dump":
            try:
                payload = self.server.state.trigger_manual_dump()  # type: ignore[attr-defined]
                body = json.dumps({"ok": True, "dump": payload}, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
            except AdbError as exc:
                body = json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8")
                self.send_response(400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(404)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(b'{"ok":false,"error":"not found"}')

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return


def render_report_html(
    package: str,
    csv_path: Path,
    meta_path: Path,
    samples: List[dict],
    started_at: str,
    ended_at: str,
    interval: float,
) -> str:
    package_html = html.escape(package)
    csv_path_html = html.escape(str(csv_path))
    meta_path_html = html.escape(str(meta_path))
    embedded_samples = json.dumps(samples, ensure_ascii=False)
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PerfSight Report</title>
  <link rel="icon" type="image/svg+xml" href="{FAVICON_DATA_URL}">
  <style>
    :root {{
      --bg: #08101b;
      --panel: rgba(14, 23, 40, 0.94);
      --border: rgba(130, 164, 255, 0.18);
      --text: #edf3ff;
      --muted: #a2b1d0;
      --cpu: #ff7a59;
      --rss: #40c4aa;
      --pss: #8fb8ff;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: "IBM Plex Sans", "Noto Sans SC", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(85, 153, 255, 0.20), transparent 32%),
        radial-gradient(circle at bottom right, rgba(64, 196, 170, 0.14), transparent 28%),
        linear-gradient(180deg, #06101d 0%, #091523 100%);
    }}
    .page {{
      width: min(1520px, calc(100vw - 32px));
      margin: 18px auto 28px;
      display: grid;
      gap: 16px;
    }}
    .panel {{
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(10px);
    }}
    .hero {{
      padding: 20px 22px;
      display: grid;
      gap: 14px;
    }}
    .hero-top {{
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      align-items: baseline;
    }}
    h1, h2 {{ margin: 0; }}
    h1 {{
      font-size: clamp(28px, 4vw, 42px);
      line-height: 1;
      letter-spacing: -0.04em;
    }}
    .sub {{ color: var(--muted); font-size: 14px; }}
    .metrics {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }}
    .card {{
      padding: 14px 16px;
      border-radius: 14px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.05);
    }}
    .label {{
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }}
    .value {{
      margin-top: 8px;
      font-size: 28px;
      font-weight: 650;
      line-height: 1;
    }}
    .content {{
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(272px, 296px);
      gap: 16px;
    }}
    .chart-wrap, .side {{
      padding: 18px;
      display: grid;
      gap: 12px;
    }}
    .chart-grid {{
      display: grid;
      gap: 12px;
    }}
    .control-row {{
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
      margin-bottom: 2px;
    }}
    .control-label {{
      min-width: 72px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }}
    .segmented {{
      display: inline-flex;
      gap: 4px;
      padding: 4px;
      border-radius: 14px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
    }}
    .chip {{
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
      padding: 7px 12px;
      border-radius: 10px;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      line-height: 1;
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease;
    }}
    .chip.active {{
      color: #08101b;
      border-color: rgba(143, 184, 255, 0.86);
      background: linear-gradient(180deg, #b9d2ff 0%, #8fb8ff 100%);
      box-shadow: 0 6px 18px rgba(143, 184, 255, 0.28);
    }}
    .mini-chart {{
      padding: 14px;
      border-radius: 14px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.05);
    }}
    .mini-head {{
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
      color: var(--muted);
      font-size: 13px;
    }}
    .mini-head strong {{ color: var(--text); }}
    canvas {{
      width: 100%;
      height: 180px;
      border-radius: 12px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.00)),
        rgba(6, 11, 22, 0.88);
    }}
    .kv {{
      display: grid;
      grid-template-columns: 90px 1fr;
      gap: 8px 12px;
      color: var(--muted);
      font-size: 14px;
    }}
    .kv strong {{
      color: var(--text);
      font-weight: 500;
      overflow-wrap: anywhere;
    }}
    .table {{
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }}
    .table th, .table td {{
      text-align: left;
      padding: 8px 0;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      color: var(--muted);
    }}
    .table td strong {{ color: var(--text); }}
    .legend {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }}
    .legend-item {{
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 5px 10px;
      border-radius: 999px;
      background: rgba(255,255,255,0.04);
      color: var(--muted);
      font-size: 12px;
      line-height: 1;
    }}
    .legend-item strong {{
      color: var(--text);
      font-weight: 500;
    }}
    .capability-hint {{
      margin-top: 10px;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid rgba(255, 209, 102, 0.22);
      background: rgba(255, 209, 102, 0.08);
      color: #ffe2a6;
      font-size: 12px;
      line-height: 1.5;
    }}
    .capability-hint.hidden {{
      display: none;
    }}
    .legend-swatch {{
      width: 10px;
      height: 10px;
      border-radius: 999px;
      display: inline-block;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.18);
    }}
    @media (max-width: 960px) {{
      .content {{ grid-template-columns: 1fr; }}
      canvas {{ height: 160px; }}
    }}
  </style>
</head>
<body>
  <div class="page">
    <section class="panel hero">
      <div class="hero-top">
        <div>
          <h1>PerfSight Report</h1>
        </div>
        <div class="sub">samples: {len(samples)} / interval: {interval:.2f}s</div>
      </div>
      <div class="metrics">
        <div class="card"><div class="label">Peak CPU</div><div class="value" id="peakCpu">-</div></div>
        <div class="card"><div class="label">Peak Total PSS</div><div class="value" id="peakRss">-</div></div>
        <div class="card"><div class="label">Top Peak Source</div><div class="value small" id="peakPss">-</div></div>
        <div class="card"><div class="label">Duration</div><div class="value" id="durationValue">-</div></div>
      </div>
    </section>
    <section class="content">
      <div class="panel chart-wrap">
        <h2>Session Curves</h2>
        <div class="control-row">
          <span class="control-label">Window</span>
          <div class="segmented toolbar" id="windowControls">
            <button class="chip" data-window="15">15s</button>
            <button class="chip active" data-window="60">1m</button>
            <button class="chip" data-window="180">3m</button>
            <button class="chip" data-window="600">10m</button>
            <button class="chip" data-window="all">All</button>
          </div>
        </div>
        <div class="control-row">
          <span class="control-label">CPU Scale</span>
          <div class="segmented toolbar" id="cpuScaleControls">
            <button class="chip active" data-cpu-scale="focus">Focus</button>
            <button class="chip" data-cpu-scale="full">Full</button>
          </div>
        </div>
        <div class="chart-grid">
          <div class="mini-chart">
            <div class="mini-head"><span>App CPU</span><strong id="cpuLabel">-</strong></div>
            <canvas id="cpuCanvas"></canvas>
          </div>
          <div class="mini-chart">
            <div class="mini-head"><span>PSS Composition</span><strong id="pssLabel">-</strong></div>
            <canvas id="pssCanvas"></canvas>
            <div class="legend" id="pssLegend"></div>
          </div>
        </div>
      </div>
      <div class="panel side">
        <h2>Session Info</h2>
        <div class="kv">
          <span>Started</span><strong>{html.escape(started_at)}</strong>
          <span>Ended</span><strong>{html.escape(ended_at)}</strong>
          <span>CSV</span><strong>{csv_path_html}</strong>
          <span>Meta</span><strong>{meta_path_html}</strong>
        </div>
        <h2>Focus Snapshot</h2>
        <div class="kv">
          <span>Total PSS</span><strong id="focusPss">-</strong>
          <span>Activities</span><strong id="focusActivities">-</strong>
          <span>ViewRootImpl</span><strong id="focusViewRoot">-</strong>
        </div>
      </div>
    </section>
  </div>
  <script>
    const samples = {embedded_samples};
    const cpuCanvas = document.getElementById("cpuCanvas");
    const pssCanvas = document.getElementById("pssCanvas");
    const pssLegend = document.getElementById("pssLegend");
    const cpuCtx = cpuCanvas.getContext("2d");
    const pssCtx = pssCanvas.getContext("2d");
    const windowControls = document.getElementById("windowControls");
    const cpuScaleControls = document.getElementById("cpuScaleControls");
    let activeWindow = "60";
    let cpuScaleMode = "focus";
    let hoverSampleIndex = null;
    let currentVisibleSamples = [];

    function resizeCanvas(canvas, ctx) {{
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }}

    function niceStep(rawStep) {{
      if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
      const exponent = Math.floor(Math.log10(rawStep));
      const fraction = rawStep / Math.pow(10, exponent);
      let niceFraction = 1;
      if (fraction <= 1) niceFraction = 1;
      else if (fraction <= 2) niceFraction = 2;
      else if (fraction <= 5) niceFraction = 5;
      else niceFraction = 10;
      return niceFraction * Math.pow(10, exponent);
    }}

    function buildTicks(minValue, maxValue, tickCount) {{
      const safeCount = Math.max(2, tickCount);
      const step = niceStep((maxValue - minValue) / (safeCount - 1));
      const niceMin = Math.floor(minValue / step) * step;
      const niceMax = Math.ceil(maxValue / step) * step;
      const ticks = [];
      for (let value = niceMin; value <= niceMax + step * 0.5; value += step) {{
        ticks.push(Number(value.toFixed(6)));
      }}
      return {{ min: niceMin, max: niceMax, ticks }};
    }}

    function computeScale(values, mode) {{
      const valid = values.filter(v => v !== null);
      if (!valid.length) return {{ min: 0, max: mode === "cpu" ? 100 : 1, ticks: [0, mode === "cpu" ? 25 : 1] }};
      if (mode === "cpu") {{
        if (cpuScaleMode === "focus") {{
          const minRaw = Math.min(...valid);
          const maxRaw = Math.max(...valid);
          const spread = Math.max(maxRaw - minRaw, 0.8);
          const padding = Math.max(spread * 0.18, 0.2);
          return buildTicks(Math.max(0, minRaw - padding), maxRaw + padding, 6);
        }}
        const peak = Math.max(...valid);
        let maxValue = 100;
        if (peak <= 20) maxValue = 25;
        else if (peak <= 40) maxValue = 50;
        else if (peak <= 80) maxValue = 100;
        else maxValue = Math.ceil(peak / 25) * 25;
        return buildTicks(0, maxValue, 5);
      }}
      const minRaw = Math.min(...valid);
      const maxRaw = Math.max(...valid);
      const spread = Math.max(maxRaw - minRaw, Math.max(1, maxRaw * 0.02));
      const padding = spread * 0.12;
      return buildTicks(Math.max(0, minRaw - padding), maxRaw + padding, 5);
    }}

    function chooseTimeStep(spanSec) {{
      const candidates = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600];
      const target = Math.max(1, spanSec / 4);
      return candidates.find(value => value >= target) || candidates[candidates.length - 1];
    }}

    function formatTick(value, suffix) {{
      if (Math.abs(value) >= 100) return `${{value.toFixed(0)}}${{suffix}}`;
      if (Math.abs(value) >= 10) return `${{value.toFixed(1)}}${{suffix}}`;
      return `${{value.toFixed(2)}}${{suffix}}`;
    }}

    function formatRelative(deltaSec) {{
      const rounded = Math.max(0, Math.round(deltaSec));
      if (rounded === 0) return "now";
      if (rounded < 60) return `-${{rounded}}s`;
      const minutes = Math.floor(rounded / 60);
      const seconds = rounded % 60;
      return seconds === 0 ? `-${{minutes}}m` : `-${{minutes}}m${{seconds}}s`;
    }}

    function formatClock(timestamp) {{
      const date = new Date(timestamp * 1000);
      const hh = String(date.getHours()).padStart(2, "0");
      const mm = String(date.getMinutes()).padStart(2, "0");
      const ss = String(date.getSeconds()).padStart(2, "0");
      const ms = String(date.getMilliseconds()).padStart(3, "0");
      return `${{hh}}:${{mm}}:${{ss}}.${{ms}}`;
    }}

    function formatNumber(value, suffix = "") {{
      return value === null || value === undefined ? "-" : `${{value.toFixed(2)}}${{suffix}}`;
    }}

    function drawYGrid(ctx, left, top, plotWidth, plotHeight, ticks, minValue, maxValue, suffix) {{
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      ctx.fillStyle = "rgba(159,176,207,0.95)";
      ctx.font = '12px "IBM Plex Sans", sans-serif';
      ticks.forEach((tick) => {{
        const ratio = (tick - minValue) / Math.max(maxValue - minValue, 1e-6);
        const y = top + plotHeight - ratio * plotHeight;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + plotWidth, y);
        ctx.stroke();
        ctx.fillText(formatTick(tick, suffix), 6, y + 4);
      }});
    }}

    function drawTimeAxis(ctx, left, top, plotWidth, plotHeight, data) {{
      if (data.length < 2) return;
      const firstTs = data[0].timestamp;
      const lastTs = data[data.length - 1].timestamp;
      const span = Math.max(1, lastTs - firstTs);
      const step = chooseTimeStep(span);
      const start = Math.ceil(firstTs / step) * step;
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.fillStyle = "rgba(159,176,207,0.95)";
      ctx.font = '12px "IBM Plex Sans", sans-serif';
      for (let ts = start; ts <= lastTs + 0.001; ts += step) {{
        const ratio = (ts - firstTs) / span;
        const x = left + ratio * plotWidth;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + plotHeight);
        ctx.stroke();
        const text = formatRelative(lastTs - ts);
        const width = ctx.measureText(text).width;
        ctx.fillText(text, x - width / 2, top + plotHeight + 18);
      }}
    }}

    function drawLine(ctx, values, color, minValue, maxValue, left, top, plotWidth, plotHeight) {{
      if (!values.some(v => v !== null)) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let lastPoint = null;
      values.forEach((value, index) => {{
        if (value === null) return;
        const x = left + (index / Math.max(values.length - 1, 1)) * plotWidth;
        const y = top + plotHeight - ((value - minValue) / Math.max(maxValue - minValue, 1e-6)) * plotHeight;
        if (index === 0 || values[index - 1] === null) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        lastPoint = {{ x, y, value }};
      }});
      ctx.stroke();
      if (lastPoint) {{
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(lastPoint.x, lastPoint.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }}
    }}

    function sliceByWindow(data) {{
      if (activeWindow === "all" || data.length < 2) return data;
      const duration = Number(activeWindow);
      const lastTs = data[data.length - 1].timestamp;
      return data.filter(sample => (lastTs - sample.timestamp) <= duration);
    }}

    function syncWindowButtons() {{
      windowControls.querySelectorAll(".chip").forEach((button) => {{
        button.classList.toggle("active", button.dataset.window === activeWindow);
      }});
    }}

    function syncCpuScaleButtons() {{
      cpuScaleControls.querySelectorAll(".chip").forEach((button) => {{
        button.classList.toggle("active", button.dataset.cpuScale === cpuScaleMode);
      }});
    }}

    function sampleIndexFromEvent(event, canvas, total) {{
      if (total <= 0) return null;
      const rect = canvas.getBoundingClientRect();
      const x = Math.min(Math.max(0, event.clientX - rect.left), rect.width);
      return Math.round((x / Math.max(rect.width, 1)) * Math.max(total - 1, 0));
    }}

    function attachHoverHandlers(canvas) {{
      canvas.addEventListener("mousemove", (event) => {{
        hoverSampleIndex = sampleIndexFromEvent(event, canvas, currentVisibleSamples.length);
        render();
      }});
      canvas.addEventListener("mouseleave", () => {{
        hoverSampleIndex = null;
        render();
      }});
    }}

    function drawHover(ctx, sample, index, total, left, top, plotWidth, plotHeight) {{
      if (!sample || total <= 0) return;
      const x = left + (index / Math.max(total - 1, 1)) * plotWidth;
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + plotHeight);
      ctx.stroke();
      const text = formatClock(sample.timestamp);
      ctx.font = '12px "IBM Plex Sans", sans-serif';
      const boxWidth = ctx.measureText(text).width + 12;
      const boxX = Math.min(Math.max(left, x - boxWidth / 2), left + plotWidth - boxWidth);
      ctx.fillStyle = "rgba(8,16,27,0.88)";
      ctx.fillRect(boxX, top + 8, boxWidth, 20);
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.strokeRect(boxX, top + 8, boxWidth, 20);
      ctx.fillStyle = "rgba(237,243,255,0.95)";
      ctx.fillText(text, boxX + 6, top + 22);
    }}

    function drawSingleChart(canvas, ctx, data, selector, color, labelNode, suffix, mode) {{
      resizeCanvas(canvas, ctx);
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      ctx.clearRect(0, 0, width, height);
      const left = 62;
      const top = 18;
      const plotWidth = width - 86;
      const plotHeight = height - 62;
      const values = data.map(selector);
      const valid = values.filter(v => v !== null);
      const scale = computeScale(values, mode);
      drawYGrid(ctx, left, top, plotWidth, plotHeight, scale.ticks, scale.min, scale.max, suffix);
      drawTimeAxis(ctx, left, top, plotWidth, plotHeight, data);
      drawLine(ctx, values, color, scale.min, scale.max, left, top, plotWidth, plotHeight);
      const hoverSample = hoverSampleIndex === null ? null : data[Math.min(hoverSampleIndex, data.length - 1)];
      drawHover(ctx, hoverSample, hoverSampleIndex ?? 0, data.length, left, top, plotWidth, plotHeight);
      const focusSample = hoverSample || data[data.length - 1];
      const focusValue = focusSample ? selector(focusSample) : null;
      labelNode.textContent = focusValue === null ? "-" : `${{focusValue.toFixed(2)}}${{suffix}}`;
    }}

    function preferredBreakdownEntries(breakdown) {{
      const order = ["java_heap", "native_heap", "graphics", "stack", "code", "private_other", "system", "unknown", "dalvik_heap", "dalvik_other", "egl_mtrack", "gl_mtrack"];
      const labels = {{
        java_heap: "Java Heap",
        native_heap: "Native Heap",
        graphics: "Graphics",
        stack: "Stack",
        code: "Code",
        private_other: "Private Other",
        system: "System",
        unknown: "Unknown",
        dalvik_heap: "Dalvik Heap",
        dalvik_other: "Dalvik Other",
        egl_mtrack: "EGL mtrack",
        gl_mtrack: "GL mtrack",
      }};
      return Object.entries(breakdown || {{}})
        .sort((a, b) => {{
          const ai = order.indexOf(a[0]);
          const bi = order.indexOf(b[0]);
          const aOrder = ai === -1 ? order.length : ai;
          const bOrder = bi === -1 ? order.length : bi;
          return aOrder - bOrder || a[0].localeCompare(b[0]);
        }})
        .map(([key, value]) => [key, labels[key] || key, value]);
    }}

    function topBreakdownEntry(breakdown) {{
      const entries = preferredBreakdownEntries(breakdown).sort((a, b) => b[2] - a[2]);
      if (!entries.length) return null;
      return {{ key: entries[0][0], label: entries[0][1], value: entries[0][2] }};
    }}

    function sumBreakdown(breakdown) {{
      return Object.values(breakdown || {{}}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    }}

    function breakdownColor(index) {{
      const palette = ["#6ca0ff", "#2ec4a6", "#ff8c61", "#ffd166", "#9be564", "#ff9db0", "#b79cff", "#72ddf7", "#f7b267", "#7bd389", "#bfc7d5", "#8d99ae"];
      return palette[index % palette.length];
    }}

    function collectBreakdownCategories(data) {{
      const categories = [];
      data.forEach((sample) => {{
        preferredBreakdownEntries(sample.pss_breakdown_mb || {{}}).forEach(([key]) => {{
          if (!categories.includes(key)) categories.push(key);
        }});
      }});
      return categories;
    }}

    function computeBreakdownScale(data) {{
      const totals = data
        .map((sample) => sample.pss_mb ?? sumBreakdown(sample.pss_breakdown_mb || {{}}))
        .filter((value) => value !== null && value > 0);
      if (!totals.length) return {{ min: 0, max: 1, ticks: [0, 0.5, 1] }};
      const peak = Math.max(...totals);
      return buildTicks(0, peak * 1.08, 6);
    }}

    function renderBreakdownLegend(categories, focusSample) {{
      const breakdown = focusSample?.pss_breakdown_mb || {{}};
      const entries = categories
        .map((key, index) => {{
          const label = preferredBreakdownEntries({{ [key]: breakdown[key] ?? 0 }})[0]?.[1] || key;
          return {{ key, label, value: breakdown[key] ?? 0, color: breakdownColor(index) }};
        }})
        .filter((entry) => entry.value > 0)
        .sort((a, b) => b.value - a.value);
      pssLegend.innerHTML = entries.length
        ? entries.map((entry) => `<span class="legend-item"><span class="legend-swatch" style="background:${{entry.color}}"></span><span>${{entry.label}}</span><strong>${{entry.value.toFixed(1)}}MB</strong></span>`).join("")
        : '<span class="legend-item">No breakdown</span>';
    }}

    function drawBreakdownChart(canvas, ctx, data, labelNode) {{
      resizeCanvas(canvas, ctx);
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      ctx.clearRect(0, 0, width, height);
      const left = 62;
      const top = 18;
      const plotWidth = width - 86;
      const plotHeight = height - 62;
      const categories = collectBreakdownCategories(data);
      const scale = computeBreakdownScale(data);
      drawYGrid(ctx, left, top, plotWidth, plotHeight, scale.ticks, scale.min, scale.max, " MB");
      drawTimeAxis(ctx, left, top, plotWidth, plotHeight, data);
      const barWidth = Math.max(3, Math.min(18, plotWidth / Math.max(data.length, 1) * 0.72));
      const focusIndex = hoverSampleIndex === null ? null : Math.min(hoverSampleIndex, data.length - 1);
      data.forEach((sample, sampleIndex) => {{
        let baseValue = 0;
        const centerX = left + (sampleIndex / Math.max(data.length - 1, 1)) * plotWidth;
        const barX = centerX - barWidth / 2;
        categories.forEach((key, index) => {{
          const value = (sample.pss_breakdown_mb || {{}})[key] ?? 0;
          if (value <= 0) return;
          const topValue = baseValue + value;
          const yTop = top + plotHeight - (topValue / Math.max(scale.max, 1e-6)) * plotHeight;
          const yBottom = top + plotHeight - (baseValue / Math.max(scale.max, 1e-6)) * plotHeight;
          const heightPx = Math.max(1, yBottom - yTop);
          const alpha = focusIndex === null || focusIndex === sampleIndex ? "dd" : "70";
          ctx.fillStyle = `${{breakdownColor(index)}}${{alpha}}`;
          ctx.fillRect(barX, yTop, barWidth, heightPx);
          ctx.strokeStyle = "rgba(8,16,27,0.28)";
          ctx.lineWidth = 0.6;
          ctx.strokeRect(barX, yTop, barWidth, heightPx);
          baseValue = topValue;
        }});
      }});
      const totalValues = data.map((sample) => sample.pss_mb ?? sumBreakdown(sample.pss_breakdown_mb || {{}}));
      drawLine(ctx, totalValues, "rgba(237,243,255,0.92)", 0, scale.max, left, top, plotWidth, plotHeight);
      const hoverSample = hoverSampleIndex === null ? null : data[Math.min(hoverSampleIndex, data.length - 1)];
      drawHover(ctx, hoverSample, hoverSampleIndex ?? 0, data.length, left, top, plotWidth, plotHeight);
      const focusSample = hoverSample || data[data.length - 1];
      const totalText = focusSample ? `${{(focusSample.pss_mb ?? sumBreakdown(focusSample.pss_breakdown_mb || {{}})).toFixed(2)}} MB` : "-";
      const javaText = focusSample && focusSample.java_heap_mb !== null && focusSample.java_heap_mb !== undefined ? `${{focusSample.java_heap_mb.toFixed(2)}} MB` : "-";
      const nativeText = focusSample && focusSample.native_heap_mb !== null && focusSample.native_heap_mb !== undefined ? `${{focusSample.native_heap_mb.toFixed(2)}} MB` : "-";
      labelNode.textContent = `Total ${{totalText}} · Java ${{javaText}} · Native ${{nativeText}}`;
      renderBreakdownLegend(categories, focusSample);
    }}

    function fillFocusSnapshot() {{
      const focusSample = hoverSampleIndex === null ? currentVisibleSamples[currentVisibleSamples.length - 1] : currentVisibleSamples[Math.min(hoverSampleIndex, currentVisibleSamples.length - 1)];
      if (!focusSample) {{
        document.getElementById("focusPss").textContent = "-";
        document.getElementById("focusActivities").textContent = "-";
        document.getElementById("focusViewRoot").textContent = "-";
        return;
      }}
      document.getElementById("focusPss").textContent = formatNumber(focusSample.pss_mb, "MB");
      document.getElementById("focusActivities").textContent = focusSample.activities ?? "-";
      document.getElementById("focusViewRoot").textContent = focusSample.view_root_impl ?? "-";
    }}

    function setSummary() {{
      const cpuValues = samples.map(s => s.app_cpu_pct).filter(v => v !== null);
      const pssValues = samples.map(s => s.pss_mb).filter(v => v !== null);
      const topEntries = samples.map(s => topBreakdownEntry(s.pss_breakdown_mb || {{}})).filter(Boolean);
      const peakEntry = topEntries.length ? topEntries.slice().sort((a, b) => b.value - a.value)[0] : null;
      document.getElementById("peakCpu").textContent = cpuValues.length ? `${{Math.max(...cpuValues).toFixed(2)}}%` : "-";
      document.getElementById("peakRss").textContent = pssValues.length ? `${{Math.max(...pssValues).toFixed(2)}}MB` : "-";
      document.getElementById("peakPss").textContent = peakEntry
        ? `${{peakEntry.label}} ${{peakEntry.value.toFixed(1)}}MB`
        : "-";
      if (samples.length >= 2) {{
        const durationSec = samples[samples.length - 1].timestamp - samples[0].timestamp;
        document.getElementById("durationValue").textContent = `${{durationSec.toFixed(1)}}s`;
      }} else {{
        document.getElementById("durationValue").textContent = "-";
      }}
    }}

    function render() {{
      currentVisibleSamples = sliceByWindow(samples);
      syncWindowButtons();
      syncCpuScaleButtons();
      setSummary();
      drawSingleChart(cpuCanvas, cpuCtx, currentVisibleSamples, sample => sample.app_cpu_pct, "#ff7a59", document.getElementById("cpuLabel"), "%", "cpu");
      drawBreakdownChart(pssCanvas, pssCtx, currentVisibleSamples, document.getElementById("pssLabel"));
      fillFocusSnapshot();
    }}

    windowControls.addEventListener("click", (event) => {{
      const button = event.target.closest("[data-window]");
      if (!button) return;
      activeWindow = button.dataset.window;
      hoverSampleIndex = null;
      render();
    }});
    cpuScaleControls.addEventListener("click", (event) => {{
      const button = event.target.closest("[data-cpu-scale]");
      if (!button) return;
      cpuScaleMode = button.dataset.cpuScale;
      render();
    }});
    [cpuCanvas, pssCanvas].forEach(attachHoverHandlers);
    window.addEventListener("resize", render);
    render();
  </script>
</body>
</html>
"""


def load_samples_from_csv(path: Path) -> List[dict]:
    if not path.exists():
        return []
    result = []
    with path.open("r", newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            pids = [int(pid) for pid in row.get("pids", "").split() if pid.isdigit()]
            result.append(
                {
                    "timestamp": float(row["timestamp_epoch"]),
                    "timestamp_iso": row["timestamp_iso"],
                    "package": row["package"],
                    "pid_count": int(row["pid_count"] or 0),
                    "pids": pids,
                    "app_cpu_pct": parse_csv_float(row.get("app_cpu_pct")),
                    "total_cpu_pct": parse_csv_float(row.get("total_cpu_pct")),
                    "rss_mb": float((row.get("rss_mb") or 0.0)),
                    "pss_mb": parse_csv_float(row.get("pss_mb")),
                    "pss_breakdown_mb": {
                        key: float(value)
                        for key, value in json.loads(row.get("pss_breakdown_json") or "{}").items()
                    },
                    "top_pss_component": top_breakdown_entry(
                        {
                            key: float(value)
                            for key, value in json.loads(row.get("pss_breakdown_json") or "{}").items()
                        }
                    ),
                    "status": row.get("status", ""),
                    "cpu_source": row.get("cpu_source", ""),
                    "java_heap_mb": parse_csv_float(row.get("java_heap_mb")),
                    "native_heap_mb": parse_csv_float(row.get("native_heap_mb")),
                    "meminfo_objects": {
                        key: value
                        for key, value in {
                            "activities": parse_csv_int(row.get("activities")),
                            "viewrootimpl": parse_csv_int(row.get("view_root_impl")),
                        }.items()
                        if value is not None
                    },
                    "activities": parse_csv_int(row.get("activities")),
                    "view_root_impl": parse_csv_int(row.get("view_root_impl")),
                    "activity_gap": parse_csv_int(row.get("activity_gap")),
                    "note": row.get("note", ""),
                    "leak_status": row.get("leak_status", "disabled"),
                    "leak_reasons": json.loads(row.get("leak_reasons") or "[]"),
                    "leak_struct_state": row.get("leak_struct_state", "struct-normal"),
                    "leak_watermark_state": row.get("leak_watermark_state", "watermark-normal"),
                    "dump_hprof_path": row.get("dump_hprof_path", ""),
                    "dump_manifest_path": row.get("dump_manifest_path", ""),
                    "dump_type": row.get("dump_type", ""),
                }
            )
    return result


def parse_csv_float(raw: Optional[str]) -> Optional[float]:
    if raw is None or raw == "":
        return None
    return float(raw)


def parse_csv_int(raw: Optional[str]) -> Optional[int]:
    if raw is None or raw == "":
        return None
    return int(raw)


def read_started_at(meta_path: Path) -> str:
    if not meta_path.exists():
        return dt.datetime.now().isoformat()
    try:
        payload = json.loads(meta_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return dt.datetime.now().isoformat()
    return str(payload.get("started_at") or dt.datetime.now().isoformat())


def render_html_page(state: WebState) -> str:
    package = html.escape(state.package)
    csv_path = html.escape(str(state.csv_path))
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PerfSight</title>
  <link rel="icon" type="image/svg+xml" href="{FAVICON_DATA_URL}">
  <style>
    :root {{
      --bg: #09111f;
      --panel: rgba(14, 25, 44, 0.88);
      --border: rgba(128, 167, 255, 0.18);
      --text: #e8f0ff;
      --muted: #9fb0cf;
      --cpu: #ff7a59;
      --rss: #40c4aa;
      --pss: #8fb8ff;
      --grid: rgba(255, 255, 255, 0.08);
      --warn: #ffd166;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100vh;
      font-family: "IBM Plex Sans", "Noto Sans SC", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(85, 153, 255, 0.24), transparent 32%),
        radial-gradient(circle at bottom right, rgba(64, 196, 170, 0.18), transparent 28%),
        linear-gradient(180deg, #07101d 0%, #0b1629 100%);
    }}
    .page {{
      width: min(1520px, calc(100vw - 32px));
      margin: 18px auto;
      display: grid;
      gap: 16px;
    }}
    .hero, .panel {{
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(10px);
    }}
    .hero {{
      padding: 20px 22px;
      display: grid;
      gap: 10px;
    }}
    .hero-top {{
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: baseline;
      flex-wrap: wrap;
    }}
    .title {{
      font-size: clamp(26px, 4vw, 42px);
      line-height: 1;
      font-weight: 650;
      letter-spacing: -0.04em;
      margin: 0;
    }}
    .sub {{
      color: var(--muted);
      font-size: 14px;
    }}
    .metrics {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }}
    .card {{
      padding: 14px 16px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }}
    .label {{
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }}
    .value {{
      margin-top: 8px;
      font-size: 30px;
      line-height: 1;
      font-weight: 650;
    }}
    .value.small {{ font-size: 18px; }}
    .content {{
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(272px, 296px);
      gap: 16px;
      align-items: start;
    }}
    .chart-wrap {{
      padding: 18px;
      display: grid;
      gap: 12px;
    }}
    .chart-grid {{
      display: grid;
      gap: 12px;
    }}
    .control-row {{
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
      margin-bottom: 2px;
    }}
    .control-label {{
      min-width: 72px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }}
    .segmented {{
      display: inline-flex;
      gap: 4px;
      padding: 4px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
    }}
    .chip {{
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
      padding: 7px 12px;
      border-radius: 10px;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      line-height: 1;
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease;
    }}
    .chip.active {{
      color: #09111f;
      border-color: rgba(143, 184, 255, 0.86);
      background: linear-gradient(180deg, #b9d2ff 0%, #8fb8ff 100%);
      box-shadow: 0 6px 18px rgba(143, 184, 255, 0.28);
    }}
    .action-button {{
      margin-left: auto;
      border: 1px solid rgba(64, 196, 170, 0.32);
      background: rgba(64, 196, 170, 0.10);
      color: var(--text);
      padding: 7px 12px;
      border-radius: 10px;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
    }}
    .action-button:disabled {{
      opacity: 0.5;
      cursor: wait;
    }}
    .action-button.hidden {{
      display: none;
    }}
    .inline-status {{
      margin-left: 8px;
      color: var(--muted);
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }}
    .inline-status.hidden {{
      display: none;
    }}
    .spinner {{
      width: 10px;
      height: 10px;
      border-radius: 999px;
      border: 2px solid rgba(255, 255, 255, 0.18);
      border-top-color: #40c4aa;
      animation: spin 0.8s linear infinite;
    }}
    .mini-chart {{
      padding: 14px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }}
    .mini-head {{
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 8px;
      color: var(--muted);
      font-size: 13px;
    }}
    .mini-head strong {{
      color: var(--text);
      font-weight: 600;
    }}
    canvas {{
      width: 100%;
      height: 180px;
      border-radius: 12px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.00)),
        rgba(6, 11, 22, 0.88);
    }}
    .side {{
      padding: 18px;
      display: grid;
      gap: 14px;
      align-content: start;
    }}
    .side h2, .chart-wrap h2 {{
      margin: 0;
      font-size: 16px;
      letter-spacing: 0.02em;
    }}
    .kv {{
      display: grid;
      grid-template-columns: 88px 1fr;
      gap: 8px 12px;
      color: var(--muted);
      font-size: 14px;
    }}
    .kv strong {{
      color: var(--text);
      font-weight: 500;
      overflow-wrap: anywhere;
    }}
    .status {{
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 999px;
      width: fit-content;
      background: rgba(255, 255, 255, 0.04);
    }}
    .pulse {{
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--cpu);
      box-shadow: 0 0 0 0 rgba(255, 122, 89, 0.5);
      animation: pulse 1.5s infinite;
    }}
    .table {{
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }}
    .table th, .table td {{
      text-align: left;
      padding: 8px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      color: var(--muted);
    }}
    .table th {{ font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }}
    .table td strong {{ color: var(--text); font-weight: 500; }}
    .legend {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }}
    .legend-item {{
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 5px 10px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.04);
      color: var(--muted);
      font-size: 12px;
      line-height: 1;
    }}
    .legend-item strong {{
      color: var(--text);
      font-weight: 500;
    }}
    .legend-swatch {{
      width: 10px;
      height: 10px;
      border-radius: 999px;
      display: inline-block;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.18);
    }}
    .warn {{ color: var(--warn); }}
    .dump-list {{
      display: grid;
      gap: 6px;
      max-height: 320px;
      overflow: auto;
      padding-right: 4px;
    }}
    .dump-summary {{
      display: flex;
      justify-content: space-between;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      margin-top: -4px;
    }}
    .dump-list::-webkit-scrollbar {{
      width: 8px;
    }}
    .dump-list::-webkit-scrollbar-track {{
      background: rgba(255, 255, 255, 0.03);
      border-radius: 999px;
    }}
    .dump-list::-webkit-scrollbar-thumb {{
      background: rgba(143, 184, 255, 0.28);
      border-radius: 999px;
    }}
    .dump-entry {{
      padding: 8px 10px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      display: grid;
      gap: 6px;
    }}
    .dump-entry-head {{
      display: flex;
      justify-content: space-between;
      gap: 10px;
      color: var(--text);
      font-size: 12px;
      font-weight: 600;
    }}
    .dump-entry-sub {{
      color: var(--muted);
      font-size: 11px;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }}
    .dump-actions {{
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }}
    .dump-link {{
      color: #b9d2ff;
      font-size: 11px;
      text-decoration: none;
    }}
    .dump-link:hover {{
      text-decoration: underline;
    }}
    .dump-tag {{
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(143, 184, 255, 0.12);
      color: #c9dcff;
      font-size: 11px;
      line-height: 1;
    }}
    @keyframes spin {{
      from {{ transform: rotate(0deg); }}
      to {{ transform: rotate(360deg); }}
    }}
    @keyframes pulse {{
      0% {{ box-shadow: 0 0 0 0 rgba(255, 122, 89, 0.5); }}
      70% {{ box-shadow: 0 0 0 12px rgba(255, 122, 89, 0); }}
      100% {{ box-shadow: 0 0 0 0 rgba(255, 122, 89, 0); }}
    }}
    @media (max-width: 960px) {{
      .content {{ grid-template-columns: 1fr; }}
      canvas {{ height: 160px; }}
    }}
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <div class="hero-top">
        <div>
          <h1 class="title">PerfSight</h1>
        </div>
      </div>
    </section>
    <section class="content">
      <div class="panel chart-wrap">
        <h2>Realtime Trends</h2>
        <div class="control-row">
          <span class="control-label">Window</span>
          <div class="segmented toolbar" id="windowControls">
            <button class="chip" data-window="15">15s</button>
            <button class="chip active" data-window="60">1m</button>
            <button class="chip" data-window="180">3m</button>
            <button class="chip" data-window="600">10m</button>
            <button class="chip" data-window="all">All</button>
          </div>
        </div>
        <div class="control-row">
          <span class="control-label">CPU Scale</span>
          <div class="segmented toolbar" id="cpuScaleControls">
            <button class="chip active" data-cpu-scale="focus">Focus</button>
            <button class="chip" data-cpu-scale="full">Full</button>
          </div>
        </div>
        <div class="chart-grid">
          <div class="mini-chart">
            <div class="mini-head"><span>App CPU</span><strong id="cpuChartLabel">-</strong></div>
            <canvas id="cpuCanvas"></canvas>
          </div>
          <div class="mini-chart">
            <div class="mini-head"><span>Total PSS & Composition</span><strong id="pssChartLabel">-</strong><button class="action-button" id="manualDumpButton" type="button">Dump Memory</button><span class="inline-status hidden" id="manualDumpStatus"><span class="spinner"></span><span>Dumping HPROF...</span></span></div>
            <canvas id="pssCanvas"></canvas>
            <div class="legend" id="pssLegend"></div>
            <div class="capability-hint hidden" id="dumpCapabilityHint"></div>
          </div>
        </div>
      </div>
      <div class="panel side">
        <h2>Config Session</h2>
        <div class="kv">
          <span>Package</span><strong>{package}</strong>
          <span>Device</span><strong id="deviceModelText">-</strong>
          <span>Android</span><strong id="androidVersionText">-</strong>
          <span>Max Java Heap</span><strong id="appMaxHeapText">-</strong>
          <span>Sampling</span><strong id="samplingText">-</strong>
          <span>Samples</span><strong id="sampleCountText">-</strong>
          <span>Source</span><strong id="sourceText">-</strong>
          <span>Debuggable</span><strong id="debuggableText">-</strong>
          <span>Profileable</span><strong id="profileableText">-</strong>
          <span>Root</span><strong id="rootedText">-</strong>
        </div>
        <h2>Current State</h2>
        <div class="status"><span class="pulse"></span><span id="statusText">waiting</span></div>
        <div class="kv">
          <span>Last</span><strong id="lastTs">-</strong>
          <span>PIDs</span><strong id="pidText">-</strong>
          <span>Note</span><strong id="noteText">-</strong>
        </div>
        <h2>Leak Snapshot</h2>
        <div class="kv">
          <span>Leak Status</span><strong id="leakText">-</strong>
          <span>Activities</span><strong id="activitiesText">-</strong>
          <span>ViewRootImpl</span><strong id="viewRootText">-</strong>
        </div>
        <h2>Dump Info</h2>
        <div class="kv">
          <span>Status</span><strong id="dumpStatusText">idle</strong>
          <span>Type</span><strong id="dumpTypeText">-</strong>
          <span>Last Dump</span><strong id="dumpTimeText">-</strong>
          <span>HPROF</span><strong id="dumpPathText">-</strong>
          <span>Manifest</span><strong id="manifestPathText">-</strong>
          <span>Message</span><strong id="dumpMessageText">-</strong>
        </div>
        <h2>Dump History</h2>
        <div class="dump-summary" id="dumpSummaryText"></div>
        <div class="dump-list" id="dumpHistoryList"></div>
      </div>
    </section>
  </div>
  <script>
    const cpuCanvas = document.getElementById("cpuCanvas");
    const pssCanvas = document.getElementById("pssCanvas");
    const cpuCtx = cpuCanvas.getContext("2d");
    const pssCtx = pssCanvas.getContext("2d");
    const pssLegend = document.getElementById("pssLegend");
    const manualDumpButton = document.getElementById("manualDumpButton");
    const manualDumpStatus = document.getElementById("manualDumpStatus");
    const dumpCapabilityHint = document.getElementById("dumpCapabilityHint");
    const cpuChartLabel = document.getElementById("cpuChartLabel");
    const pssChartLabel = document.getElementById("pssChartLabel");
    const windowControls = document.getElementById("windowControls");
    const cpuScaleControls = document.getElementById("cpuScaleControls");
    const deviceModelText = document.getElementById("deviceModelText");
    const androidVersionText = document.getElementById("androidVersionText");
    const appMaxHeapText = document.getElementById("appMaxHeapText");
    const samplingText = document.getElementById("samplingText");
    const sampleCountText = document.getElementById("sampleCountText");
    const statusText = document.getElementById("statusText");
    const lastTs = document.getElementById("lastTs");
    const pidText = document.getElementById("pidText");
    const sourceText = document.getElementById("sourceText");
    const debuggableText = document.getElementById("debuggableText");
    const profileableText = document.getElementById("profileableText");
    const rootedText = document.getElementById("rootedText");
    const noteText = document.getElementById("noteText");
    const leakText = document.getElementById("leakText");
    const activitiesText = document.getElementById("activitiesText");
    const viewRootText = document.getElementById("viewRootText");
    const dumpTimeText = document.getElementById("dumpTimeText");
    const dumpPathText = document.getElementById("dumpPathText");
    const manifestPathText = document.getElementById("manifestPathText");
    const dumpTypeText = document.getElementById("dumpTypeText");
    const dumpStatusText = document.getElementById("dumpStatusText");
    const dumpMessageText = document.getElementById("dumpMessageText");
    const dumpSummaryText = document.getElementById("dumpSummaryText");
    const dumpHistoryList = document.getElementById("dumpHistoryList");
    let pollTimer = null;
    let activeWindow = "60";
    let cpuScaleMode = "focus";
    let hoverSampleIndex = null;
    let currentSamples = [];
    let currentVisibleSamples = [];
    let lastSeenDumpKey = null;
    let lastSeenDumpReady = false;
    let notificationsReady = false;
    let dumpInFlight = false;
    let manualDumpMessage = "";
    let currentAppSessionId = null;

    function dumpCapabilitySummary(payload) {{
      if (!payload || payload.manual_dump_enabled) return "";
      if (payload.manual_dump_reason === "leak capture disabled") return "";
      return "Leak monitoring stays on, but HPROF dump is unavailable for this app. Enable debuggable/profileable support or use a rooted device to capture heap dumps.";
    }}

    function defaultDumpMessage(payload) {{
      if (!payload || payload.manual_dump_enabled) return "-";
      return payload.manual_dump_reason || "-";
    }}

    function handleAppSessionChange(payload) {{
      if (!payload) return;
      if (payload.app_session_id === currentAppSessionId) return;
      currentAppSessionId = payload.app_session_id;
      manualDumpMessage = "";
      dumpInFlight = false;
      hoverSampleIndex = null;
      if (manualDumpButton) {{
        manualDumpButton.classList.remove("hidden");
      }}
      if (manualDumpStatus) {{
        manualDumpStatus.classList.add("hidden");
      }}
      lastSeenDumpKey = makeDumpKey(currentPayloadLastDumpSample());
      lastSeenDumpReady = true;
    }}

    function resolveDumpStatusText(payload) {{
      if (payload?.dump_in_progress) {{
        return payload.dump_in_progress_type === "leak" ? "auto dumping" : "dumping";
      }}
      const dumpSample = currentPayloadLastDumpSample() || findLatestDumpSample(currentSamples);
      return dumpSample ? "ready" : (payload?.manual_dump_enabled === false && payload?.manual_dump_reason !== "leak capture disabled" ? "unsupported" : "idle");
    }}

    function syncDumpLoadingFromPayload(payload) {{
      if (payload?.dump_in_progress) {{
        setDumpLoading(true, resolveDumpStatusText(payload));
        return;
      }}
      if (dumpInFlight) {{
        setDumpLoading(false, resolveDumpStatusText(payload));
      }}
    }}

    function resizeCanvas(canvas, ctx) {{
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }}

    function formatNumber(value, suffix = "") {{
      return value === null || value === undefined ? "-" : `${{value.toFixed(2)}}${{suffix}}`;
    }}

    function niceStep(rawStep) {{
      if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
      const exponent = Math.floor(Math.log10(rawStep));
      const fraction = rawStep / Math.pow(10, exponent);
      let niceFraction = 1;
      if (fraction <= 1) niceFraction = 1;
      else if (fraction <= 2) niceFraction = 2;
      else if (fraction <= 5) niceFraction = 5;
      else niceFraction = 10;
      return niceFraction * Math.pow(10, exponent);
    }}

    function buildTicks(minValue, maxValue, tickCount) {{
      const safeCount = Math.max(2, tickCount);
      const step = niceStep((maxValue - minValue) / (safeCount - 1));
      const niceMin = Math.floor(minValue / step) * step;
      const niceMax = Math.ceil(maxValue / step) * step;
      const ticks = [];
      for (let value = niceMin; value <= niceMax + step * 0.5; value += step) {{
        ticks.push(Number(value.toFixed(6)));
      }}
      return {{ min: niceMin, max: niceMax, ticks }};
    }}

    function computeScale(values, mode) {{
      const valid = values.filter(v => v !== null);
      if (!valid.length) return {{ min: 0, max: mode === "cpu" ? 100 : 1, ticks: [0, mode === "cpu" ? 25 : 1] }};
      if (mode === "cpu") {{
        if (cpuScaleMode === "focus") {{
          const minRaw = Math.min(...valid);
          const maxRaw = Math.max(...valid);
          const spread = Math.max(maxRaw - minRaw, 0.8);
          const padding = Math.max(spread * 0.18, 0.2);
          return buildTicks(Math.max(0, minRaw - padding), maxRaw + padding, 6);
        }}
        const peak = Math.max(...valid);
        let maxValue = 100;
        if (peak <= 20) maxValue = 25;
        else if (peak <= 40) maxValue = 50;
        else if (peak <= 80) maxValue = 100;
        else maxValue = Math.ceil(peak / 25) * 25;
        return buildTicks(0, maxValue, 5);
      }}
      const minRaw = Math.min(...valid);
      const maxRaw = Math.max(...valid);
      const spread = Math.max(maxRaw - minRaw, Math.max(1, maxRaw * 0.02));
      const padding = spread * 0.12;
      return buildTicks(Math.max(0, minRaw - padding), maxRaw + padding, 5);
    }}

    function chooseTimeStep(spanSec) {{
      const candidates = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600];
      const target = Math.max(1, spanSec / 4);
      return candidates.find(value => value >= target) || candidates[candidates.length - 1];
    }}

    function formatTick(value, suffix) {{
      if (Math.abs(value) >= 100) return `${{value.toFixed(0)}}${{suffix}}`;
      if (Math.abs(value) >= 10) return `${{value.toFixed(1)}}${{suffix}}`;
      return `${{value.toFixed(2)}}${{suffix}}`;
    }}

    function formatRelative(deltaSec) {{
      const rounded = Math.max(0, Math.round(deltaSec));
      if (rounded === 0) return "now";
      if (rounded < 60) return `-${{rounded}}s`;
      const minutes = Math.floor(rounded / 60);
      const seconds = rounded % 60;
      return seconds === 0 ? `-${{minutes}}m` : `-${{minutes}}m${{seconds}}s`;
    }}

    function formatClock(timestamp) {{
      const date = new Date(timestamp * 1000);
      const hh = String(date.getHours()).padStart(2, "0");
      const mm = String(date.getMinutes()).padStart(2, "0");
      const ss = String(date.getSeconds()).padStart(2, "0");
      const ms = String(date.getMilliseconds()).padStart(3, "0");
      return `${{hh}}:${{mm}}:${{ss}}.${{ms}}`;
    }}

    function ensureNotificationPermission() {{
      if (!("Notification" in window)) return;
      if (Notification.permission === "granted") {{
        notificationsReady = true;
        return;
      }}
      if (Notification.permission !== "default") return;
      Notification.requestPermission().then((permission) => {{
        notificationsReady = permission === "granted";
      }}).catch(() => {{
        notificationsReady = false;
      }});
    }}

    function makeDumpKey(sample) {{
      if (!sample) return null;
      return sample.dump_manifest_path || sample.dump_hprof_path || (sample.timestamp ? `dump-${{sample.timestamp}}` : null);
    }}

    function notifyDump(sample) {{
      if (!sample || !notificationsReady || !("Notification" in window)) return;
      const body = [
        sample.package || "unknown package",
        `Total ${{sample.pss_mb !== null && sample.pss_mb !== undefined ? sample.pss_mb.toFixed(2) : "-"}}MB`,
        `Java ${{sample.java_heap_mb !== null && sample.java_heap_mb !== undefined ? sample.java_heap_mb.toFixed(2) : "-"}}MB`,
        `Native ${{sample.native_heap_mb !== null && sample.native_heap_mb !== undefined ? sample.native_heap_mb.toFixed(2) : "-"}}MB`,
      ].join(" · ");
      const dumpType = sample.dump_type || "leak";
      const notification = new Notification(`PerfSight HPROF Dumped (${{dumpType}})`, {{
        body,
        tag: makeDumpKey(sample) || undefined,
      }});
      notification.onclick = () => {{
        window.focus();
        if (sample.hprof_download_url) {{
          window.open(sample.hprof_download_url, "_blank", "noopener,noreferrer");
        }}
        document.querySelector(".side")?.scrollIntoView({{ behavior: "smooth", block: "start" }});
      }};
    }}

    function drawYGrid(ctx, left, top, plotWidth, plotHeight, ticks, minValue, maxValue, suffix) {{
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      ctx.fillStyle = "rgba(159,176,207,0.95)";
      ctx.font = '12px "IBM Plex Sans", sans-serif';
      ticks.forEach((tick) => {{
        const ratio = (tick - minValue) / Math.max(maxValue - minValue, 1e-6);
        const y = top + plotHeight - ratio * plotHeight;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + plotWidth, y);
        ctx.stroke();
        ctx.fillText(formatTick(tick, suffix), 6, y + 4);
      }});
    }}

    function drawTimeAxis(ctx, left, top, plotWidth, plotHeight, samples) {{
      if (samples.length < 2) return;
      const firstTs = samples[0].timestamp;
      const lastTs = samples[samples.length - 1].timestamp;
      const span = Math.max(1, lastTs - firstTs);
      const step = chooseTimeStep(span);
      const start = Math.ceil(firstTs / step) * step;
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.fillStyle = "rgba(159,176,207,0.95)";
      ctx.font = '12px "IBM Plex Sans", sans-serif';
      for (let ts = start; ts <= lastTs + 0.001; ts += step) {{
        const ratio = (ts - firstTs) / span;
        const x = left + ratio * plotWidth;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + plotHeight);
        ctx.stroke();
        const text = formatRelative(lastTs - ts);
        const width = ctx.measureText(text).width;
        ctx.fillText(text, x - width / 2, top + plotHeight + 18);
      }}
    }}

    function drawLine(ctx, values, color, minValue, maxValue, left, top, plotWidth, plotHeight) {{
      const filtered = values.map(v => v ?? null);
      if (!filtered.some(v => v !== null)) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let lastPoint = null;
      filtered.forEach((value, index) => {{
        if (value === null) return;
        const x = left + (index / Math.max(filtered.length - 1, 1)) * plotWidth;
        const y = top + plotHeight - ((value - minValue) / Math.max(maxValue - minValue, 1e-6)) * plotHeight;
        if (index === 0 || filtered[index - 1] === null) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        lastPoint = {{ x, y }};
      }});
      ctx.stroke();
      if (lastPoint) {{
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(lastPoint.x, lastPoint.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }}
    }}

    function sliceByWindow(data) {{
      if (activeWindow === "all" || data.length < 2) return data;
      const duration = Number(activeWindow);
      const lastTs = data[data.length - 1].timestamp;
      return data.filter(sample => (lastTs - sample.timestamp) <= duration);
    }}

    function syncWindowButtons() {{
      windowControls.querySelectorAll(".chip").forEach((button) => {{
        button.classList.toggle("active", button.dataset.window === activeWindow);
      }});
    }}

    function syncCpuScaleButtons() {{
      cpuScaleControls.querySelectorAll(".chip").forEach((button) => {{
        button.classList.toggle("active", button.dataset.cpuScale === cpuScaleMode);
      }});
    }}

    function sampleIndexFromEvent(event, canvas, total) {{
      if (total <= 0) return null;
      const rect = canvas.getBoundingClientRect();
      const x = Math.min(Math.max(0, event.clientX - rect.left), rect.width);
      return Math.round((x / Math.max(rect.width, 1)) * Math.max(total - 1, 0));
    }}

    function attachHoverHandlers(canvas) {{
      canvas.addEventListener("mousemove", (event) => {{
        hoverSampleIndex = sampleIndexFromEvent(event, canvas, currentVisibleSamples.length);
        refreshBreakdownViews();
      }});
      canvas.addEventListener("mouseleave", () => {{
        hoverSampleIndex = null;
        refreshBreakdownViews();
      }});
    }}

    function drawHover(ctx, sample, index, total, left, top, plotWidth, plotHeight) {{
      if (!sample || total <= 0) return;
      const x = left + (index / Math.max(total - 1, 1)) * plotWidth;
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + plotHeight);
      ctx.stroke();
      const text = formatClock(sample.timestamp);
      ctx.font = '12px "IBM Plex Sans", sans-serif';
      const boxWidth = ctx.measureText(text).width + 12;
      const boxX = Math.min(Math.max(left, x - boxWidth / 2), left + plotWidth - boxWidth);
      ctx.fillStyle = "rgba(8,16,27,0.88)";
      ctx.fillRect(boxX, top + 8, boxWidth, 20);
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.strokeRect(boxX, top + 8, boxWidth, 20);
      ctx.fillStyle = "rgba(237,243,255,0.95)";
      ctx.fillText(text, boxX + 6, top + 22);
    }}

    function drawSingleChart(canvas, ctx, samples, selector, color, formatter, labelNode, mode, suffix) {{
      resizeCanvas(canvas, ctx);
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      ctx.clearRect(0, 0, width, height);
      const left = 62;
      const top = 18;
      const plotWidth = width - 86;
      const plotHeight = height - 62;
      const values = samples.map(selector);
      const validValues = values.filter(v => v !== null);
      const scale = computeScale(values, mode);
      drawYGrid(ctx, left, top, plotWidth, plotHeight, scale.ticks, scale.min, scale.max, suffix);
      drawTimeAxis(ctx, left, top, plotWidth, plotHeight, samples);
      drawLine(ctx, values, color, scale.min, scale.max, left, top, plotWidth, plotHeight);
      const hoverSample = hoverSampleIndex === null ? null : samples[Math.min(hoverSampleIndex, samples.length - 1)];
      drawHover(ctx, hoverSample, hoverSampleIndex ?? 0, samples.length, left, top, plotWidth, plotHeight);
      const focusSample = hoverSample || samples[samples.length - 1];
      const focusValue = focusSample ? selector(focusSample) : null;
      labelNode.textContent = focusValue === null ? "-" : `${{formatter(focusValue)}}`;
    }}

    function preferredBreakdownEntries(breakdown) {{
      const order = ["java_heap", "native_heap", "graphics", "stack", "code", "private_other", "system", "unknown", "dalvik_heap", "dalvik_other", "egl_mtrack", "gl_mtrack"];
      const labels = {{
        java_heap: "Java Heap",
        native_heap: "Native Heap",
        graphics: "Graphics",
        stack: "Stack",
        code: "Code",
        private_other: "Private Other",
        system: "System",
        unknown: "Unknown",
        dalvik_heap: "Dalvik Heap",
        dalvik_other: "Dalvik Other",
        egl_mtrack: "EGL mtrack",
        gl_mtrack: "GL mtrack",
      }};
      return Object.entries(breakdown || {{}})
        .sort((a, b) => {{
          const ai = order.indexOf(a[0]);
          const bi = order.indexOf(b[0]);
          const aOrder = ai === -1 ? order.length : ai;
          const bOrder = bi === -1 ? order.length : bi;
          return aOrder - bOrder || a[0].localeCompare(b[0]);
        }})
        .map(([key, value]) => [key, labels[key] || key, value]);
    }}

    function topBreakdownEntry(breakdown) {{
      const entries = preferredBreakdownEntries(breakdown).sort((a, b) => b[2] - a[2]);
      if (!entries.length) return null;
      return {{ key: entries[0][0], label: entries[0][1], value: entries[0][2] }};
    }}

    function sumBreakdown(breakdown) {{
      return Object.values(breakdown || {{}}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    }}

    function breakdownColor(index) {{
      const palette = ["#6ca0ff", "#2ec4a6", "#ff8c61", "#ffd166", "#9be564", "#ff9db0", "#b79cff", "#72ddf7", "#f7b267", "#7bd389", "#bfc7d5", "#8d99ae"];
      return palette[index % palette.length];
    }}

    function collectBreakdownCategories(samples) {{
      const categories = [];
      samples.forEach((sample) => {{
        preferredBreakdownEntries(sample.pss_breakdown_mb || {{}}).forEach(([key]) => {{
          if (!categories.includes(key)) categories.push(key);
        }});
      }});
      return categories;
    }}

    function computeBreakdownScale(samples) {{
      const totals = samples
        .map((sample) => sample.pss_mb ?? sumBreakdown(sample.pss_breakdown_mb || {{}}))
        .filter((value) => value !== null && value > 0);
      if (!totals.length) return {{ min: 0, max: 1, ticks: [0, 0.5, 1] }};
      const peak = Math.max(...totals);
      return buildTicks(0, peak * 1.08, 6);
    }}

    function renderBreakdownLegend(categories, focusSample) {{
      const breakdown = focusSample?.pss_breakdown_mb || {{}};
      const entries = categories
        .map((key, index) => {{
          const label = preferredBreakdownEntries({{ [key]: breakdown[key] ?? 0 }})[0]?.[1] || key;
          return {{ key, label, value: breakdown[key] ?? 0, color: breakdownColor(index) }};
        }})
        .filter((entry) => entry.value > 0)
        .sort((a, b) => b.value - a.value);
      pssLegend.innerHTML = entries.length
        ? entries.map((entry) => `<span class="legend-item"><span class="legend-swatch" style="background:${{entry.color}}"></span><span>${{entry.label}}</span><strong>${{entry.value.toFixed(1)}}MB</strong></span>`).join("")
        : '<span class="legend-item">No breakdown</span>';
    }}

    function refreshBreakdownViews() {{
      drawCharts(currentSamples);
      updateDetails();
    }}

    function applyDumpEventToPayload(event) {{
      if (!event) return;
      if (!currentPayload) {{
        currentPayload = {{
          latest: null,
          samples: currentSamples,
          dump_history: [],
          last_dump_event: null,
          manual_dump_enabled: true,
          manual_dump_reason: "",
          interval_sec: 0,
        }};
      }}
      currentPayload.last_dump_event = event;
      const history = Array.isArray(currentPayload.dump_history) ? currentPayload.dump_history.slice() : [];
      const deduped = history.filter((item) => item.id !== event.id);
      deduped.unshift(event);
      currentPayload.dump_history = deduped;
      const latestSample = currentSamples[currentSamples.length - 1];
      if (latestSample) {{
        latestSample.dump_hprof_path = event.dump_hprof_path || latestSample.dump_hprof_path;
        latestSample.dump_manifest_path = event.dump_manifest_path || latestSample.dump_manifest_path;
        latestSample.dump_type = event.dump_type || latestSample.dump_type;
        if (event.dump_hprof_name) {{
          latestSample.note = `manual dump saved: ${{event.dump_hprof_name}}`;
        }}
      }}
    }}

    function drawBreakdownChart(canvas, ctx, samples, labelNode) {{
      resizeCanvas(canvas, ctx);
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      ctx.clearRect(0, 0, width, height);
      const left = 62;
      const top = 18;
      const plotWidth = width - 86;
      const plotHeight = height - 62;
      const categories = collectBreakdownCategories(samples);
      const scale = computeBreakdownScale(samples);
      drawYGrid(ctx, left, top, plotWidth, plotHeight, scale.ticks, scale.min, scale.max, " MB");
      drawTimeAxis(ctx, left, top, plotWidth, plotHeight, samples);
      const barWidth = Math.max(3, Math.min(18, plotWidth / Math.max(samples.length, 1) * 0.72));
      const focusIndex = hoverSampleIndex === null ? null : Math.min(hoverSampleIndex, samples.length - 1);
      samples.forEach((sample, sampleIndex) => {{
        let baseValue = 0;
        const centerX = left + (sampleIndex / Math.max(samples.length - 1, 1)) * plotWidth;
        const barX = centerX - barWidth / 2;
        categories.forEach((key, index) => {{
          const value = (sample.pss_breakdown_mb || {{}})[key] ?? 0;
          if (value <= 0) return;
          const topValue = baseValue + value;
          const yTop = top + plotHeight - (topValue / Math.max(scale.max, 1e-6)) * plotHeight;
          const yBottom = top + plotHeight - (baseValue / Math.max(scale.max, 1e-6)) * plotHeight;
          const heightPx = Math.max(1, yBottom - yTop);
          const alpha = focusIndex === null || focusIndex === sampleIndex ? "dd" : "70";
          ctx.fillStyle = `${{breakdownColor(index)}}${{alpha}}`;
          ctx.fillRect(barX, yTop, barWidth, heightPx);
          ctx.strokeStyle = "rgba(8,16,27,0.28)";
          ctx.lineWidth = 0.6;
          ctx.strokeRect(barX, yTop, barWidth, heightPx);
          baseValue = topValue;
        }});
      }});
      const totalValues = samples.map((sample) => sample.pss_mb ?? sumBreakdown(sample.pss_breakdown_mb || {{}}));
      drawLine(ctx, totalValues, "rgba(237,243,255,0.92)", 0, scale.max, left, top, plotWidth, plotHeight);
      const hoverSample = hoverSampleIndex === null ? null : samples[Math.min(hoverSampleIndex, samples.length - 1)];
      drawHover(ctx, hoverSample, hoverSampleIndex ?? 0, samples.length, left, top, plotWidth, plotHeight);
      const focusSample = hoverSample || samples[samples.length - 1];
      const totalText = focusSample ? `${{(focusSample.pss_mb ?? sumBreakdown(focusSample.pss_breakdown_mb || {{}})).toFixed(2)}} MB` : "-";
      const javaText = focusSample && focusSample.java_heap_mb !== null && focusSample.java_heap_mb !== undefined ? `${{focusSample.java_heap_mb.toFixed(2)}} MB` : "-";
      const nativeText = focusSample && focusSample.native_heap_mb !== null && focusSample.native_heap_mb !== undefined ? `${{focusSample.native_heap_mb.toFixed(2)}} MB` : "-";
      labelNode.textContent = `Total ${{totalText}} · Java ${{javaText}} · Native ${{nativeText}}`;
      renderBreakdownLegend(categories, focusSample);
    }}

    function drawCharts(samples) {{
      currentVisibleSamples = sliceByWindow(samples);
      syncWindowButtons();
      syncCpuScaleButtons();
      drawSingleChart(
        cpuCanvas,
        cpuCtx,
        currentVisibleSamples,
        sample => sample.app_cpu_pct,
        "#ff7a59",
        value => `${{value.toFixed(2)}}%`,
        cpuChartLabel,
        "cpu",
        "%",
      );
      drawBreakdownChart(pssCanvas, pssCtx, currentVisibleSamples, pssChartLabel);
    }}

    function findLatestDumpSample(samples) {{
      for (let index = samples.length - 1; index >= 0; index -= 1) {{
        if (samples[index].dump_hprof_path) return samples[index];
      }}
      return null;
    }}

    function updateDetails() {{
      const samples = currentVisibleSamples;
      const focusSample = hoverSampleIndex === null ? samples[samples.length - 1] : samples[Math.min(hoverSampleIndex, samples.length - 1)];
      const dumpSample = currentPayload ? currentPayloadLastDumpSample() : findLatestDumpSample(currentSamples);
      if (!dumpInFlight) {{
        dumpStatusText.textContent = resolveDumpStatusText(currentPayload);
      }}
      dumpTypeText.textContent = dumpSample?.dump_type || "-";
      dumpTimeText.textContent = dumpSample ? formatClock(dumpSample.timestamp) : "-";
      dumpPathText.textContent = dumpSample?.dump_hprof_name || basename(dumpSample?.dump_hprof_path);
      manifestPathText.textContent = dumpSample?.dump_manifest_name || basename(dumpSample?.dump_manifest_path);
      dumpMessageText.textContent = currentPayload?.dump_in_progress_message || manualDumpMessage || defaultDumpMessage(currentPayload);
      renderDumpHistory(currentPayload?.dump_history || []);
      if (!focusSample) {{
        leakText.textContent = "-";
        activitiesText.textContent = "-";
        viewRootText.textContent = "-";
        return;
      }}
      leakText.textContent = focusSample.leak_status || "-";
      activitiesText.textContent = focusSample.activities ?? "-";
      viewRootText.textContent = focusSample.view_root_impl ?? "-";
    }}

    let currentPayload = null;

    function currentPayloadLastDumpSample() {{
      const event = currentPayload?.last_dump_event;
      if (!event) return null;
      return {{
        id: event.id,
        package: event.package,
        timestamp: event.timestamp,
        dump_type: event.dump_type,
        dump_hprof_path: event.dump_hprof_path,
        dump_manifest_path: event.dump_manifest_path,
        dump_hprof_name: event.dump_hprof_name,
        dump_manifest_name: event.dump_manifest_name,
        java_heap_mb: event.java_heap_mb,
        native_heap_mb: event.native_heap_mb,
        pss_mb: event.pss_mb,
        hprof_download_url: event.hprof_download_url,
        manifest_download_url: event.manifest_download_url,
      }};
    }}

    function basename(path) {{
      if (!path) return "-";
      const segments = String(path).split("/");
      return segments[segments.length - 1] || path;
    }}

    function setDumpLoading(active, status = "idle") {{
      dumpInFlight = active;
      if (manualDumpButton) {{
        manualDumpButton.disabled = active || !(currentPayload?.manual_dump_enabled ?? true);
        manualDumpButton.classList.toggle("hidden", active);
      }}
      if (manualDumpStatus) {{
        manualDumpStatus.classList.toggle("hidden", !active);
      }}
      if (dumpStatusText) {{
        dumpStatusText.textContent = status;
      }}
    }}

    function renderDumpHistory(history) {{
      if (!dumpHistoryList) return;
      if (dumpSummaryText) {{
        const safeHistory = history || [];
        const manualCount = safeHistory.filter((entry) => entry.dump_type === "manual").length;
        const leakCount = safeHistory.filter((entry) => entry.dump_type === "leak").length;
        dumpSummaryText.textContent = safeHistory.length ? `Total ${{safeHistory.length}} · Manual ${{manualCount}} · Leak ${{leakCount}}` : "No dumps yet";
      }}
      if (!history || !history.length) {{
        dumpHistoryList.innerHTML = '<div class="dump-entry"><div class="dump-entry-sub">No dumps yet</div></div>';
        return;
      }}
      dumpHistoryList.innerHTML = history.map((entry) => `
        <div class="dump-entry">
          <div class="dump-entry-head">
            <span>${{entry.timestamp ? formatClock(entry.timestamp) : "-"}}</span>
            <span class="dump-tag">${{entry.dump_type || "-"}}</span>
          </div>
          <div class="dump-entry-sub">PID ${{entry.pid ?? "-"}} · ${{entry.dump_hprof_name || basename(entry.dump_hprof_path)}}</div>
          <div class="dump-actions">
            <a class="dump-link" href="${{entry.hprof_download_url}}" download>HPROF</a>
            <a class="dump-link" href="${{entry.manifest_download_url}}" download>Manifest</a>
          </div>
        </div>
      `).join("");
    }}

    async function triggerManualDump() {{
      if (!manualDumpButton || manualDumpButton.disabled) return;
      setDumpLoading(true, "dumping");
      try {{
        const response = await fetch("/api/dump", {{
          method: "POST",
          cache: "no-store",
        }});
        const payload = await response.json();
        if (!response.ok || !payload.ok) {{
          throw new Error(payload.error || "manual dump failed");
        }}
        applyDumpEventToPayload(payload.dump);
        manualDumpMessage = `manual dump saved: ${{payload.dump.dump_hprof_name || basename(payload.dump.dump_hprof_path)}}`;
        lastSeenDumpKey = makeDumpKey(payload.dump);
        lastSeenDumpReady = true;
        setDumpLoading(false, "ready");
        noteText.textContent = manualDumpMessage;
        notifyDump(payload.dump);
        refreshBreakdownViews();
        await poll(true);
      }} catch (error) {{
        manualDumpMessage = `manual dump failed: ${{String(error)}}`;
        setDumpLoading(false, "failed");
        noteText.textContent = manualDumpMessage;
        refreshBreakdownViews();
      }}
    }}

    function updateMetrics(payload) {{
      const latest = payload.latest;
      const deviceInfo = payload.device_info || {{}};
      deviceModelText.textContent = deviceInfo.model || "-";
      androidVersionText.textContent = deviceInfo.android || "-";
      appMaxHeapText.textContent = payload.app_max_java_heap_mb !== null && payload.app_max_java_heap_mb !== undefined
        ? `${{payload.app_max_java_heap_mb.toFixed(2)}} MB`
        : "-";
      samplingText.textContent = `${{payload.interval_sec.toFixed(2)}}s`;
      sampleCountText.textContent = `${{payload.samples.length}} pts`;
      if (manualDumpButton && !dumpInFlight) {{
        manualDumpButton.disabled = !payload.manual_dump_enabled;
      }}
      const capabilityHint = dumpCapabilitySummary(payload);
      if (dumpCapabilityHint) {{
        dumpCapabilityHint.textContent = capabilityHint || "";
        dumpCapabilityHint.classList.toggle("hidden", !capabilityHint);
      }}
      if (payload.dump_in_progress_message) {{
        dumpMessageText.textContent = payload.dump_in_progress_message;
      }} else if (!manualDumpMessage) {{
        dumpMessageText.textContent = defaultDumpMessage(payload);
      }}
      debuggableText.textContent = payload.debuggable ? "supported" : "unsupported";
      profileableText.textContent = payload.profileable ? "supported" : "unsupported";
      rootedText.textContent = payload.rooted ? "supported" : "unsupported";
      if (payload.connection_status === "disconnected") {{
        statusText.textContent = "device disconnected";
        noteText.textContent = payload.connection_note || "waiting for device reconnect";
        lastTs.textContent = "-";
        pidText.textContent = "-";
        sourceText.textContent = "-";
        return;
      }}
      if (!latest) {{
        statusText.textContent = "waiting for first sample";
        lastTs.textContent = "-";
        pidText.textContent = "-";
        sourceText.textContent = "-";
        noteText.textContent = manualDumpMessage || "-";
        return;
      }}
      statusText.textContent = latest.status;
      lastTs.textContent = formatClock(latest.timestamp);
      pidText.textContent = latest.pids.length ? latest.pids.join(", ") : "-";
      sourceText.textContent = latest.cpu_source;
      noteText.textContent = manualDumpMessage || latest.note || "-";
    }}

    async function poll(skipSchedule = false) {{
      try {{
        const response = await fetch("/api/state", {{ cache: "no-store" }});
        const payload = await response.json();
        currentPayload = payload;
        handleAppSessionChange(payload);
        syncDumpLoadingFromPayload(payload);
        currentSamples = payload.samples;
        const latestDumpSample = currentPayloadLastDumpSample();
        const latestDumpKey = makeDumpKey(latestDumpSample);
        if (!lastSeenDumpReady) {{
          lastSeenDumpKey = latestDumpKey;
          lastSeenDumpReady = true;
        }} else if (latestDumpKey && latestDumpKey !== lastSeenDumpKey) {{
          lastSeenDumpKey = latestDumpKey;
          notifyDump(latestDumpSample);
        }}
        updateMetrics(payload);
        refreshBreakdownViews();
      }} catch (error) {{
        statusText.textContent = "reconnecting";
        noteText.textContent = "waiting for local watcher";
      }} finally {{
        if (!skipSchedule) {{
          pollTimer = window.setTimeout(poll, 800);
        }}
      }}
    }}

    windowControls.addEventListener("click", (event) => {{
      const button = event.target.closest("[data-window]");
      if (!button) return;
      activeWindow = button.dataset.window;
      hoverSampleIndex = null;
      refreshBreakdownViews();
    }});
    cpuScaleControls.addEventListener("click", (event) => {{
      const button = event.target.closest("[data-cpu-scale]");
      if (!button) return;
      cpuScaleMode = button.dataset.cpuScale;
      refreshBreakdownViews();
    }});
    [cpuCanvas, pssCanvas].forEach(attachHoverHandlers);
    window.addEventListener("resize", refreshBreakdownViews);
    manualDumpButton?.addEventListener("click", triggerManualDump);
    ensureNotificationPermission();
    poll();
  </script>
</body>
</html>
"""


def render_series(values: Iterable[Optional[float]], width: int, max_value: Optional[float]) -> str:
    clean_values = [0.0 if value is None else max(0.0, value) for value in values]
    if not clean_values:
        return ""
    if len(clean_values) > width:
        step = len(clean_values) / width
        reduced = []
        for index in range(width):
            start = int(index * step)
            end = max(start + 1, int((index + 1) * step))
            window = clean_values[start:end]
            reduced.append(sum(window) / len(window))
        clean_values = reduced
    upper = max_value if max_value is not None else max(clean_values) or 1.0
    chars = []
    for value in clean_values:
        idx = min(len(SPARK_CHARS) - 1, int(round((value / upper) * (len(SPARK_CHARS) - 1))))
        chars.append(SPARK_CHARS[idx])
    return "".join(chars)


def fmt_float(value: Optional[float]) -> str:
    if value is None:
        return ""
    return f"{value:.2f}"


def round_or_none(value: Optional[float]) -> Optional[float]:
    return None if value is None else round(value, 2)


def fmt_metric(value: Optional[float], suffix: str, width: int = 0) -> str:
    text = "-" if value is None else f"{value:.2f}{suffix}"
    return f"{text:>{width}}" if width else text


def format_top_component(breakdown: dict[str, float], width: int = 0) -> str:
    top = top_breakdown_entry(breakdown)
    if not top:
        text = "-"
    else:
        text = f"{top['label']} {top['value']:.1f}MB"
    return text[:width] if width else text


def join_pids(pids: Sequence[int]) -> str:
    return ",".join(str(pid) for pid in pids) if pids else "-"


def create_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Watch Android app CPU and memory usage over adb.")
    parser.add_argument("package", help="Android package name, for example com.mi.car.mobile")
    parser.add_argument("--interval", type=float, default=0.5, help="sample interval in seconds")
    parser.add_argument("--pss-interval", type=float, default=3.0, help="PSS refresh interval in seconds, 0 disables throttling")
    parser.add_argument("--history-size", type=int, default=120, help="number of points kept in the dashboard")
    parser.add_argument("--output-dir", default="data", help="directory for archived samples")
    parser.add_argument("--serial", help="adb device serial")
    parser.add_argument(
        "--mode",
        choices=("terminal", "text", "web"),
        default="terminal",
        help="display mode: curses terminal, plain text, or local web page",
    )
    parser.add_argument("--host", default="127.0.0.1", help="web mode bind host")
    parser.add_argument("--port", type=int, default=8765, help="web mode bind port")
    parser.add_argument("--no-open-browser", action="store_true", help="do not auto-open the browser in web mode")
    parser.add_argument("--no-export-report", action="store_true", help="do not export an offline HTML report when the session ends")
    parser.add_argument("--no-ui", action="store_true", help="disable curses dashboard and print text rows")
    parser.add_argument("--enable-leak-capture", action="store_true", help="enable leak detection and automatic HPROF dump")
    parser.add_argument("--leak-java-max-heap-mb", type=float, default=0.0, help="optional max Java heap size recorded in session metadata")
    parser.add_argument("--leak-java-watch-ratio", type=float, default=0.70, help="watch threshold ratio against max Java heap")
    parser.add_argument("--leak-java-dump-ratio", type=float, default=0.80, help="dump threshold ratio against max Java heap")
    parser.add_argument("--leak-dump-threshold-mb", type=float, default=256.0, help="Total PSS threshold for structure-only HPROF dumps")
    parser.add_argument("--leak-warmup-sec", type=float, default=10.0, help="warmup time before leak rules become active")
    parser.add_argument("--leak-cooldown-sec", type=float, default=900.0, help="cooldown after one HPROF dump")
    parser.add_argument("--leak-struct-gap-suspect", type=int, default=2, help="Activities - ViewRootImpl gap treated as suspicious")
    parser.add_argument("--leak-struct-gap-high", type=int, default=3, help="Activities - ViewRootImpl gap treated as high confidence")
    parser.add_argument("--leak-max-dumps-per-pid", type=int, default=2, help="maximum automatic HPROF dumps for one pid")
    parser.add_argument("--leak-max-dumps-per-session", type=int, default=3, help="maximum automatic HPROF dumps for one session")
    parser.add_argument("--leak-dump-dir", default="captures", help="directory used to store pulled HPROF files")
    return parser


def write_session_meta(
    path: Path,
    package: str,
    interval: float,
    pss_interval: float,
    serial: Optional[str],
    device_info: Optional[dict[str, str]] = None,
    leak_config: Optional[LeakJudgeConfig] = None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "package": package,
        "interval_sec": interval,
        "pss_interval_sec": pss_interval,
        "serial": serial,
        "started_at": dt.datetime.now().isoformat(),
    }
    if device_info:
        payload["device"] = dict(device_info)
    if leak_config is not None:
        payload["leak_capture"] = {
            "enabled": leak_config.enabled,
            "dump_threshold_mb": leak_config.dump_threshold_mb,
            "java_heap_max_mb": leak_config.java_heap_max_mb,
            "java_heap_watch_ratio": leak_config.java_heap_watch_ratio,
            "java_heap_dump_ratio": leak_config.java_heap_dump_ratio,
            "warmup_sec": leak_config.warmup_sec,
            "cooldown_sec": leak_config.cooldown_sec,
            "struct_gap_suspect": leak_config.struct_gap_suspect,
            "struct_gap_high": leak_config.struct_gap_high,
            "max_dumps_per_pid": leak_config.max_dumps_per_pid,
            "max_dumps_per_session": leak_config.max_dumps_per_session,
            "dump_dir": str(leak_config.dump_dir),
        }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def build_leak_config(args, adb: AdbClient) -> LeakJudgeConfig:
    java_heap_max_mb = max(0.0, float(args.leak_java_max_heap_mb))
    if java_heap_max_mb <= 0:
        java_heap_max_mb = adb.java_heap_growth_limit_mb() or 0.0
    java_heap_watch_ratio = max(0.0, min(1.0, float(args.leak_java_watch_ratio)))
    java_heap_dump_ratio = max(java_heap_watch_ratio, min(1.0, float(args.leak_java_dump_ratio)))
    dump_threshold_mb = max(0.0, float(args.leak_dump_threshold_mb))
    return LeakJudgeConfig(
        enabled=bool(args.enable_leak_capture),
        warmup_sec=float(args.leak_warmup_sec),
        dump_threshold_mb=dump_threshold_mb,
        java_heap_max_mb=java_heap_max_mb,
        java_heap_watch_ratio=java_heap_watch_ratio,
        java_heap_dump_ratio=java_heap_dump_ratio,
        struct_gap_suspect=int(args.leak_struct_gap_suspect),
        struct_gap_high=int(args.leak_struct_gap_high),
        struct_suspect_hits=2,
        struct_high_hits=6,
        struct_high_gap_hits=3,
        struct_recover_hits=3,
        cooldown_sec=float(args.leak_cooldown_sec),
        max_dumps_per_pid=int(args.leak_max_dumps_per_pid),
        max_dumps_per_session=int(args.leak_max_dumps_per_session),
        dump_dir=Path(args.leak_dump_dir),
    )


def resolve_dump_capability(
    adb: AdbClient,
    package: str,
    leak_config: LeakJudgeConfig,
    output_dir: Path,
) -> tuple[Optional[HprofCapture], dict[str, object]]:
    if not leak_config.enabled:
        capabilities = adb.package_capabilities(package)
        capabilities["dump_reason"] = "leak capture disabled"
        return None, capabilities
    capabilities = adb.package_capabilities(package)
    if not capabilities["debuggable"] and not capabilities["rooted"]:
        return None, capabilities
    return (
        HprofCapture(
            adb=adb,
            package=package,
            capture_dir=output_dir / leak_config.dump_dir,
            use_root=bool(capabilities["rooted"]) and not bool(capabilities["debuggable"]),
        ),
        capabilities,
    )


def current_main_pid(snapshot: Snapshot) -> Optional[int]:
    return snapshot.pids[0] if snapshot.pids else None


def refresh_runtime_capabilities(
    adb: AdbClient,
    package: str,
    leak_config: LeakJudgeConfig,
    output_dir: Path,
    leak_manager: LeakCaptureManager,
    state: Optional[WebState] = None,
) -> dict[str, object]:
    leak_capture, capabilities = resolve_dump_capability(adb, package, leak_config, output_dir)
    leak_manager.capture = leak_capture
    if state is not None:
        state.capture = leak_capture
        state.dump_reason = str(capabilities["dump_reason"])
        state.debuggable = bool(capabilities["debuggable"])
        state.profileable = bool(capabilities["profileable"])
        state.rooted = bool(capabilities["rooted"])
        state.device_info = adb.device_info()
    return capabilities


def print_sample_line(sample: Sample) -> None:
    ts = dt.datetime.fromtimestamp(sample.timestamp).strftime("%H:%M:%S")
    print(
        f"{ts} cpu={fmt_metric(sample.app_cpu_pct, '%')} "
        f"pss={fmt_metric(sample.pss_mb, 'MB')} top={format_top_component(sample.pss_breakdown_mb)} "
        f"java={fmt_metric(sample.java_heap_mb, 'MB')} gap={sample.activity_gap if sample.activity_gap is not None else '-'} "
        f"leak={sample.leak_status} pids={join_pids(sample.pids)} cpu_src={sample.cpu_source} "
        f"status={sample.status} {sample.note}".strip()
    )


def run_text_mode(
    collector: PackageCollector,
    writer: SampleWriter,
    package: str,
    interval: float,
    leak_manager: LeakCaptureManager,
) -> None:
    prev = collector.snapshot()
    while True:
        time.sleep(interval)
        curr = collector.snapshot()
        sample = leak_manager.process(build_sample(prev, curr, package))
        writer.write(sample)
        print_sample_line(sample)
        prev = curr


def run_ui_mode(
    collector: PackageCollector,
    writer: SampleWriter,
    dashboard: Dashboard,
    package: str,
    interval: float,
    leak_manager: LeakCaptureManager,
) -> None:
    prev = collector.snapshot()
    next_tick = time.monotonic() + interval

    def loop(stdscr) -> None:
        nonlocal prev, next_tick
        while True:
            key = stdscr.getch()
            if key in (ord("q"), ord("Q")):
                break
            now = time.monotonic()
            if now >= next_tick:
                curr = collector.snapshot()
                sample = leak_manager.process(build_sample(prev, curr, package))
                writer.write(sample)
                dashboard.add(sample)
                prev = curr
                next_tick = now + interval
            dashboard.draw(stdscr)
            time.sleep(0.05)

    dashboard.run(loop)


def run_web_mode(
    adb: AdbClient,
    collector: PackageCollector,
    writer: SampleWriter,
    state: WebState,
    package: str,
    interval: float,
    host: str,
    port: int,
    open_browser: bool,
    leak_manager: LeakCaptureManager,
    leak_config: LeakJudgeConfig,
    output_dir: Path,
) -> None:
    server = PerfHttpServer((host, port), PerfRequestHandler, state)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    url_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    url = f"http://{url_host}:{port}"
    print(f"Web UI: {url}")
    print("Press Ctrl-C to stop.")
    if open_browser:
        threading.Thread(target=lambda: webbrowser.open(url, new=2), daemon=True).start()

    prev = collector.snapshot()
    active_pid = current_main_pid(prev)
    state.set_connection_state("connected")
    try:
        while True:
            try:
                time.sleep(interval)
                curr = collector.snapshot()
                if state.connection_status != "connected":
                    reconnect_note = ""
                    device_changed, _ = adb.sync_device_identity()
                    if device_changed:
                        collector.reset_runtime_cache()
                        reconnect_note = "switched to a different device"
                        state.reset_for_device_change(reconnect_note)
                    refresh_runtime_capabilities(adb, package, leak_config, output_dir, leak_manager, state)
                    state.set_connection_state("connected", reconnect_note)
                    prev = curr
                curr_pid = current_main_pid(curr)
                if curr_pid != active_pid:
                    refresh_runtime_capabilities(adb, package, leak_config, output_dir, leak_manager, state)
                    active_pid = curr_pid
                sample = leak_manager.process(build_sample(prev, curr, package))
                writer.write(sample)
                state.sync_app_session(sample)
                state.sample_store.add(sample)
                state.record_dump_from_sample(sample)
                prev = curr
            except AdbError as exc:
                state.set_connection_state("disconnected", str(exc))
                collector.reset_runtime_cache()
                active_pid = None
                time.sleep(min(max(interval, 1.0), 3.0))
    finally:
        server.shutdown()
        server.server_close()


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = create_arg_parser()
    args = parser.parse_args(argv)
    writer: Optional[SampleWriter] = None
    report_path: Optional[Path] = None
    csv_path: Optional[Path] = None
    meta_path: Optional[Path] = None

    def handle_signal(signum, frame) -> None:  # noqa: ARG001
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        adb = AdbClient(serial=args.serial)
        adb.ensure_device()
        device_info = adb.device_info()
        leak_config = build_leak_config(args, adb)

        timestamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        output_dir = Path(args.output_dir)
        output_prefix = output_dir / f"{args.package.replace('.', '_')}_{timestamp}"
        csv_path = output_prefix.with_suffix(".csv")
        meta_path = output_prefix.with_suffix(".json")
        report_path = output_prefix.parent / f"{output_prefix.name}_report.html"
        write_session_meta(
            meta_path,
            args.package,
            args.interval,
            args.pss_interval,
            args.serial,
            device_info=device_info,
            leak_config=leak_config,
        )

        collector = PackageCollector(adb=adb, package=args.package, pss_interval=args.pss_interval)
        writer = SampleWriter(csv_path)
        sample_store = SampleStore(args.history_size)
        leak_judge = LeakJudge(leak_config) if leak_config.enabled else None
        leak_capture, app_capabilities = resolve_dump_capability(adb, args.package, leak_config, output_dir)
        dump_reason = str(app_capabilities["dump_reason"])
        if leak_config.enabled:
            print(f"HPROF dump: {dump_reason}")
        leak_manager = LeakCaptureManager(leak_judge, leak_capture)

        mode = "text" if args.no_ui else args.mode
        if mode == "text":
            run_text_mode(collector, writer, args.package, args.interval, leak_manager)
        elif mode == "terminal":
            dashboard = Dashboard(
                package=args.package,
                interval=args.interval,
                history_size=args.history_size,
                csv_path=csv_path,
                sample_store=sample_store,
            )
            run_ui_mode(collector, writer, dashboard, args.package, args.interval, leak_manager)
        else:
            state = WebState(
                package=args.package,
                interval=args.interval,
                csv_path=csv_path,
                meta_path=meta_path,
                sample_store=sample_store,
                capture=leak_capture,
                dump_reason=dump_reason,
                debuggable=bool(app_capabilities["debuggable"]),
                profileable=bool(app_capabilities["profileable"]),
                rooted=bool(app_capabilities["rooted"]),
                device_info=device_info,
                app_max_java_heap_mb=leak_config.java_heap_max_mb or None,
            )
            leak_manager.state = state
            run_web_mode(
                adb=adb,
                collector=collector,
                writer=writer,
                state=state,
                package=args.package,
                interval=args.interval,
                host=args.host,
                port=args.port,
                open_browser=not args.no_open_browser,
                leak_manager=leak_manager,
                leak_config=leak_config,
                output_dir=output_dir,
            )
    except KeyboardInterrupt:
        pass
    except AdbError as exc:
        message = str(exc).strip()
        if AdbClient.is_device_unavailable_error(message):
            print("adb device unavailable: please connect or reconnect a phone, then retry.", file=sys.stderr)
        else:
            print(f"adb error: {message}", file=sys.stderr)
        return 1
    finally:
        if writer is not None:
            writer.close()
        if not args.no_export_report and csv_path is not None and meta_path is not None and report_path is not None:
            samples = load_samples_from_csv(csv_path)
            report_html = render_report_html(
                package=args.package,
                csv_path=csv_path,
                meta_path=meta_path,
                samples=samples,
                started_at=read_started_at(meta_path),
                ended_at=dt.datetime.now().isoformat(),
                interval=args.interval,
            )
            report_path.write_text(report_html, encoding="utf-8")
            print(f"Report exported: {report_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
