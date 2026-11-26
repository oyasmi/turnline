"""Lightweight passcode authentication, login rate limiting and WebSocket caps."""

import base64
from collections import deque
from contextlib import contextmanager
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import secrets
from tempfile import NamedTemporaryFile
from time import monotonic, time

from .connection import loopback
from .http_support import WS_AUTH_CLOSE_CODE

MIN_PASSCODE_LENGTH = 8
MAX_PASSCODE_LENGTH = 128
DEFAULT_SESSION_DAYS = 30
LOGIN_BODY_LIMIT = 1024

SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32

WS_LIMIT_CLOSE_CODE = 4429
MAX_VOICE_SOCKETS = 4
MAX_RESPONSES_SOCKETS = 8

AUTH_FILENAME = "auth.json"


def validate_passcode(passcode):
    if not isinstance(passcode, str) or not passcode.strip():
        raise ValueError("访问口令不能为空。")
    if len(passcode) < MIN_PASSCODE_LENGTH:
        raise ValueError(f"访问口令长度至少需要 {MIN_PASSCODE_LENGTH} 位。")
    if len(passcode) > MAX_PASSCODE_LENGTH:
        raise ValueError(f"访问口令长度不能超过 {MAX_PASSCODE_LENGTH} 位。")
    return passcode


def hash_passcode(passcode):
    validate_passcode(passcode)
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(
        passcode.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=SCRYPT_DKLEN,
    )
    return {
        "algorithm": "scrypt",
        "n": SCRYPT_N,
        "r": SCRYPT_R,
        "p": SCRYPT_P,
        "salt": base64.b64encode(salt).decode("ascii"),
        "hash": base64.b64encode(derived).decode("ascii"),
        "updated_at": int(time()),
    }


def verify_passcode_hash(passcode, record):
    if not isinstance(passcode, str) or not passcode or len(passcode) > MAX_PASSCODE_LENGTH:
        return False
    if not isinstance(record, dict) or record.get("algorithm") != "scrypt":
        return False
    try:
        salt = base64.b64decode(record["salt"], validate=True)
        expected = base64.b64decode(record["hash"], validate=True)
        n = int(record["n"])
        r = int(record["r"])
        p = int(record["p"])
        if n < 2**12 or r < 1 or p < 1 or len(salt) < 8 or len(expected) < 16:
            return False
        derived = hashlib.scrypt(
            passcode.encode("utf-8"),
            salt=salt,
            n=n,
            r=r,
            p=p,
            dklen=len(expected),
        )
    except (KeyError, TypeError, ValueError):
        return False
    return hmac.compare_digest(derived, expected)


def auth_file(state_dir):
    return Path(state_dir) / AUTH_FILENAME


def save_passcode(state_dir, passcode):
    record = hash_passcode(passcode)
    directory = Path(state_dir)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = auth_file(directory)
    with NamedTemporaryFile("w", dir=directory, prefix=".auth-", suffix=".tmp",
                            encoding="utf-8", delete=False) as tmp:
        tmp_path = Path(tmp.name)
        try:
            os.chmod(tmp_path, 0o600)
            json.dump(record, tmp, indent=2)
            tmp.write("\n")
            tmp.flush()
            os.fsync(tmp.fileno())
        except Exception:
            tmp_path.unlink(missing_ok=True)
            raise
    tmp_path.replace(target)
    return target


def load_passcode_record(state_dir):
    target = auth_file(state_dir)
    if not target.exists():
        return None
    try:
        record = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"无法读取口令文件 {target}，请重新设置口令。") from exc
    if not isinstance(record, dict) or record.get("algorithm") != "scrypt":
        raise ValueError(f"口令文件 {target} 格式无效，请重新设置口令。")
    return record


class PasscodeVerifier:
    def __init__(self, record, *, source="file"):
        self.record = record
        self.source = source

    @classmethod
    def from_plaintext(cls, passcode, *, source="env"):
        return cls(hash_passcode(passcode), source=source)

    @classmethod
    def load(cls, state_dir):
        passcode_file = os.environ.get("TURNLINE_PASSCODE_FILE")
        if passcode_file:
            path = Path(passcode_file)
            try:
                raw = path.read_text(encoding="utf-8").rstrip("\r\n")
            except OSError as exc:
                raise ValueError(f"无法读取 TURNLINE_PASSCODE_FILE ({path})：{exc}") from exc
            return cls.from_plaintext(raw, source="env-file")
        env_passcode = os.environ.get("TURNLINE_PASSCODE")
        if env_passcode:
            return cls.from_plaintext(env_passcode, source="env")
        record = load_passcode_record(state_dir)
        if record is None:
            return None
        return cls(record, source="file")

    def verify(self, candidate):
        return verify_passcode_hash(candidate, self.record)


class LoginRateLimiter:
    """In-memory per-IP progressive lockout with a global brute-force circuit breaker."""

    IP_WINDOW = 900.0
    IP_SOFT_LIMIT = 5
    IP_SOFT_LOCK = 60.0
    IP_HARD_LIMIT = 10
    IP_HARD_LOCK = 900.0
    GLOBAL_WINDOW = 60.0
    GLOBAL_LIMIT = 20
    GLOBAL_LOCK = 120.0
    MAX_TRACKED_IPS = 1024

    def __init__(self, *, clock=monotonic):
        self.clock = clock
        self._ips = {}
        self._global_failures = deque()
        self._global_locked_until = 0.0

    def _prune(self, now):
        cutoff = now - self.GLOBAL_WINDOW
        while self._global_failures and self._global_failures[0] <= cutoff:
            self._global_failures.popleft()
        if len(self._ips) > self.MAX_TRACKED_IPS:
            stale = [ip for ip, state in self._ips.items()
                     if state["locked_until"] <= now and now - state["last_failure"] > self.IP_WINDOW]
            for ip in stale:
                self._ips.pop(ip, None)
            if len(self._ips) > self.MAX_TRACKED_IPS:
                oldest = sorted(self._ips.items(), key=lambda item: item[1]["last_failure"])
                for ip, _ in oldest[:len(self._ips) - self.MAX_TRACKED_IPS // 2]:
                    self._ips.pop(ip, None)

    def check(self, ip):
        now = self.clock()
        self._prune(now)
        remaining = max(0.0, self._global_locked_until - now)
        state = self._ips.get(ip)
        if state:
            if state["locked_until"] <= now and now - state["last_failure"] > self.IP_WINDOW:
                self._ips.pop(ip, None)
            else:
                remaining = max(remaining, state["locked_until"] - now)
        return int(remaining + 0.999) if remaining > 0 else 0

    def record_failure(self, ip):
        now = self.clock()
        self._prune(now)
        self._global_failures.append(now)
        if len(self._global_failures) >= self.GLOBAL_LIMIT:
            self._global_locked_until = max(self._global_locked_until, now + self.GLOBAL_LOCK)

        state = self._ips.get(ip)
        if state is None or (state["locked_until"] <= now and now - state["last_failure"] > self.IP_WINDOW):
            state = {"failures": 0, "last_failure": now, "locked_until": 0.0}
            self._ips[ip] = state
        state["failures"] += 1
        state["last_failure"] = now
        if state["failures"] >= self.IP_HARD_LIMIT:
            state["locked_until"] = max(state["locked_until"], now + self.IP_HARD_LOCK)
        elif state["failures"] >= self.IP_SOFT_LIMIT:
            state["locked_until"] = max(state["locked_until"], now + self.IP_SOFT_LOCK)
        return self.check(ip)

    def record_success(self, ip):
        self._ips.pop(ip, None)


class ConnectionLimiter:
    def __init__(self, limits):
        self.limits = dict(limits)
        self._active = {kind: 0 for kind in self.limits}

    @contextmanager
    def acquire(self, kind):
        limit = self.limits[kind]
        if self._active[kind] >= limit:
            yield False
            return
        self._active[kind] += 1
        try:
            yield True
        finally:
            self._active[kind] -= 1


def client_ip(connection):
    peer = connection.scope.get("client")
    host = peer[0] if peer else "unknown"
    if loopback(host):
        forwarded = connection.headers.get("x-forwarded-for")
        if forwarded:
            candidate = forwarded.split(",")[0].strip()
            try:
                ipaddress.ip_address(candidate)
                return candidate
            except ValueError:
                pass
    return host


class AuthGate:
    def __init__(self, *, mode="none", verifier=None, sessions=None,
                 session_seconds=DEFAULT_SESSION_DAYS * 86400,
                 max_voice_sockets=MAX_VOICE_SOCKETS,
                 max_responses_sockets=MAX_RESPONSES_SOCKETS,
                 limiter=None):
        if mode not in {"none", "passcode"}:
            raise ValueError("Unsupported auth mode.")
        if mode == "passcode" and verifier is None:
            raise ValueError("Passcode verifier is required when auth mode is passcode.")
        self.mode = mode
        self.verifier = verifier
        self.sessions = sessions
        self.session_seconds = session_seconds
        self.limiter = limiter or LoginRateLimiter()
        self.ws_limiter = ConnectionLimiter({
            "voice": max_voice_sockets,
            "responses": max_responses_sockets,
        })

    @property
    def enabled(self):
        return self.mode == "passcode"

    def verify(self, passcode):
        return bool(self.verifier and self.verifier.verify(passcode))
