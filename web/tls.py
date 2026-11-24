"""Issue reusable LAN certificates from a private Turnline CA."""

from contextlib import ExitStack
from hashlib import sha256
import ipaddress
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory


def certificates(state_dir, hostname):
    # The certificate name comes from the validated public URL, never a request.
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        san = f"DNS:{hostname}"
    else:
        san = f"IP:{address}"

    import fcntl

    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = state_dir / "tls"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    ca = directory / "ca.pem"
    ca_key = directory / "ca-key.pem"
    name = sha256(hostname.encode("ascii")).hexdigest()[:16]
    cert = directory / f"{name}.pem"
    key = directory / f"{name}-key.pem"

    def openssl(*args, check=True):
        result = subprocess.run(["openssl", *args], text=True, capture_output=True)
        if check and result.returncode:
            raise ValueError(result.stderr.strip() or "OpenSSL failed.")
        return result.returncode == 0

    with ExitStack() as stack:
        lock = stack.enter_context((directory / ".lock").open("a"))
        fcntl.flock(lock, fcntl.LOCK_EX)
        stage = Path(stack.enter_context(TemporaryDirectory(dir=directory)))
        if ca.exists() != ca_key.exists():
            raise ValueError(f"Restore both {ca} and {ca_key} to keep using the existing local CA.")
        if not ca.exists():
            openssl(
                "req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "3650", "-sha256",
                "-subj", "/CN=Turnline local CA", "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign",
                "-keyout", stage / "ca-key.pem", "-out", stage / "ca.pem",
            )
            (stage / "ca-key.pem").chmod(0o600)
            (stage / "ca-key.pem").replace(ca_key)
            (stage / "ca.pem").replace(ca)
        if (cert.exists() and key.exists()
                and openssl("x509", "-in", cert, "-noout", "-checkend", "1209600", check=False)
                and openssl("verify", "-CAfile", ca, cert, check=False)):
            return cert, key, ca

        openssl(
            "req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=Turnline",
            "-out", stage / "leaf.csr", "-keyout", stage / "leaf-key.pem",
        )
        extensions = stage / "extensions.cnf"
        extensions.write_text(
            f"subjectAltName={san}\n"
            "basicConstraints=critical,CA:FALSE\n"
            "keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
            encoding="ascii",
        )
        openssl(
            "x509", "-req", "-in", stage / "leaf.csr", "-CA", ca, "-CAkey", ca_key,
            "-CAcreateserial", "-days", "365", "-sha256", "-extfile", extensions,
            "-out", stage / "leaf.pem",
        )
        (stage / "leaf-key.pem").chmod(0o600)
        (stage / "leaf-key.pem").replace(key)
        (stage / "leaf.pem").replace(cert)
    return cert, key, ca
