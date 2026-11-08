import urllib.request, ssl, hashlib, sys, time, os

URL = "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-full_build.zip"
EXPECTED_SHA256 = "759d0a9831c436a0eb331ad36f236c06cb04aaa0005da46571f0e9d3d9206f6b"
DEST = r"D:\demo\workspace\ffmpeg-9.0.2-full_build.zip"

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

print(f"Downloading {URL}", flush=True)
print(f"To: {DEST}", flush=True)

t0 = time.time()
h = hashlib.sha256()
downloaded = 0
last_print = 0

req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, timeout=60, context=ctx) as r, open(DEST, "wb") as f:
    total = int(r.headers.get("Content-Length", 0))
    print(f"Total size: {total} bytes ({total/1024/1024:.1f} MB)", flush=True)
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
            print(f"{downloaded/1024/1024:.1f}/{total/1024/1024:.1f} MB ({pct:.1f}%) {speed:.2f} MB/s", flush=True)
            last_print = now

elapsed = time.time() - t0
print(f"Downloaded {downloaded} bytes in {elapsed:.1f}s", flush=True)

digest = h.hexdigest()
print(f"SHA256 actual:   {digest}", flush=True)
print(f"SHA256 expected: {EXPECTED_SHA256}", flush=True)
if digest == EXPECTED_SHA256:
    print("SHA256 VERIFIED OK", flush=True)
    sys.exit(0)
else:
    print("SHA256 MISMATCH!", flush=True)
    sys.exit(1)
