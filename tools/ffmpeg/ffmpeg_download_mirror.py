import urllib.request, ssl, hashlib, sys, time

BASE = "https://registry.npmmirror.com/-/binary/ffmpeg-builds/v8.1.3/"
TARBALL = "ffmpeg-8.1.3-win32-x64-gpl.tar.xz"
SHAFILE = "ffmpeg-8.1.3.sha256.txt"
DEST = r".\ffmpeg-8.1.3-win32-x64-gpl.tar.xz"
DEST_SHA = r".\ffmpeg-8.1.3.sha256.txt"

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def fetch(url, dest, label, expected=None, chunk_out=None):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    t0 = time.time()
    downloaded = 0
    h = hashlib.sha256()
    last_print = 0
    with urllib.request.urlopen(req, timeout=60, context=ctx) as r, open(dest, "wb") as f:
        total = int(r.headers.get("Content-Length", 0))
        print(f"[{label}] {total/1024/1024:.1f} MB", flush=True)
        while True:
            chunk = r.read(1024 * 512)
            if not chunk:
                break
            f.write(chunk)
            h.update(chunk)
            downloaded += len(chunk)
            now = time.time()
            if now - last_print >= 3:
                speed = downloaded / (now - t0) / 1024 / 1024
                pct = (downloaded / total * 100) if total else 0
                print(f"[{label}] {downloaded/1024/1024:.1f}/{total/1024/1024:.1f} MB ({pct:.1f}%) {speed:.2f} MB/s", flush=True)
                last_print = now
    print(f"[{label}] done {downloaded/1024/1024:.1f} MB in {time.time()-t0:.1f}s", flush=True)
    return h.hexdigest()

# 1) download tarball
digest = fetch(BASE + TARBALL, DEST, "tarball")
print(f"SHA256 actual: {digest}", flush=True)

# 2) download the publisher's sha256 manifest
fetch(BASE + SHAFILE, DEST_SHA, "sha256", )

manifest = open(DEST_SHA, "r", encoding="utf-8", errors="replace").read()
print("--- manifest ---", flush=True)
print(manifest, flush=True)

expected = None
for line in manifest.splitlines():
    if TARBALL in line:
        expected = line.split()[0].strip().lower()
        break

print(f"SHA256 expected: {expected}", flush=True)
if expected and digest == expected:
    print("SHA256 VERIFIED OK", flush=True)
    sys.exit(0)
else:
    print("SHA256 MISMATCH or not found in manifest", flush=True)
    sys.exit(1)
