#!/bin/sh
# T-KAT-01: recompute the Appendix A known-answer vectors with implementations independent of
# slate_crypto_core.c — the OpenSSL CLI (`openssl kdf`, `openssl enc`, `openssl dgst`), Python's
# hashlib/hmac, Node's node:crypto and hash-wasm — and compare each with the expected value, which
# must also be the literal test/kat.c checks the native module against.
#
# T-PQ-A1-08: the ACVP ML-DSA sigVer vectors (test/vectors/mldsa/sigver.h, which kat.c and pq.test.ts verify
# through the module) must get the same verdict from `openssl pkeyutl -verify -rawin`.
#
# Needs: an OpenSSL 3.5+ CLI (ARGON2ID, ML-DSA; set OPENSSL=...), python3, node, xxd. Run from anywhere:
#   sh packages/native/test/crossCheck.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
kat="$here/kat.c"
OPENSSL=${OPENSSL:-openssl}
fails=0

ver=$("$OPENSSL" version)
case "$ver" in
  "OpenSSL 3.0."* | "OpenSSL 3.1."* | "OpenSSL 3.2."* | "OpenSSL 3.3."* | "OpenSSL 3.4."* | LibreSSL*) echo "crossCheck: $OPENSSL is '$ver'; need OpenSSL 3.5+ (set OPENSSL=)" >&2; exit 2 ;;
esac
echo "crossCheck with $ver, $(python3 --version), node $(node --version)"

norm() { tr -d ':\n ' | tr 'A-F' 'a-f'; }
hexrep() { python3 -c "import sys; print(sys.argv[1]*int(sys.argv[2]))" "$1" "$2"; }
# expect NAME GOT WANT [in-kat]: also requires WANT to appear in kat.c when the 4th argument is "kat".
expect() {
  if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 got $2 want $3"; fails=$((fails + 1)); fi
  if [ "${4:-}" = kat ] && ! grep -q "$3" "$kat"; then echo "FAIL $1: $3 is not the value test/kat.c checks"; fails=$((fails + 1)); fi
}

MK=000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
VID=000000000000400080000000000000aa
S11=$(hexrep 11 16)

# SHA-256 (FIPS 180-4 example)
W=ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
expect "SHA-256 python" "$(python3 -c 'import hashlib; print(hashlib.sha256(b"abc").hexdigest())')" $W kat
expect "SHA-256 openssl dgst" "$(printf abc | "$OPENSSL" dgst -sha256 -r | cut -d' ' -f1)" $W

# HMAC-SHA-256 (RFC 4231 TC2)
W=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843
expect "HMAC-SHA-256 python" "$(python3 -c 'import hmac,hashlib; print(hmac.new(b"Jefe".ljust(32,b"\0"), b"what do ya want for nothing?", hashlib.sha256).hexdigest())')" $W kat

# AES-256 block (FIPS 197 C.3)
W=8ea2b7ca516745bfeafc49904b496089
expect "AES-256 openssl enc -aes-256-ecb" "$(printf 00112233445566778899aabbccddeeff | xxd -r -p | "$OPENSSL" enc -aes-256-ecb -nopad -K $MK | xxd -p | norm)" $W kat

# AES-256-GCM (McGrew-Viega TC14)
W=cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919
expect "AES-256-GCM node:crypto" "$(node -e '
const c = require("node:crypto").createCipheriv("aes-256-gcm", Buffer.alloc(32), Buffer.alloc(12))
const ct = Buffer.concat([c.update(Buffer.alloc(16)), c.final()])
process.stdout.write(Buffer.concat([ct, c.getAuthTag()]).toString("hex"))')" $W kat

# SP 800-108r1 KBKDF, counter mode, HMAC-SHA-256
kbkdf() { "$OPENSSL" kdf -keylen 32 -kdfopt mac:HMAC -kdfopt digest:SHA256 -kdfopt "hexkey:$1" -kdfopt "salt:$2" -kdfopt "hexinfo:$3" KBKDF | norm; }
kbkdf_py() {
  python3 -c '
import hmac, hashlib, sys
k, label, ctx = bytes.fromhex(sys.argv[1]), sys.argv[2].encode(), bytes.fromhex(sys.argv[3])
print(hmac.new(k, (1).to_bytes(4, "big") + label + b"\0" + ctx + (256).to_bytes(4, "big"), hashlib.sha256).hexdigest())' "$1" "$2" "$3"
}
KSYNC=88ec1b4b04f78edf70ae4735963fa883f98c3bdfd18863c7cd6e8eb02b7b5388
expect "KBKDF kSync openssl kdf" "$(kbkdf $MK slate/v2/sync $VID)" $KSYNC kat
expect "KBKDF kSync python" "$(kbkdf_py $MK slate/v2/sync $VID)" $KSYNC
KFILE=ccc0c941926d90b66ab707799a53336118ec8590779bd7b244719575a403696a
expect "KBKDF file key openssl kdf" "$(kbkdf $KSYNC slate/v2/remote-file "$S11")" $KFILE kat
expect "KBKDF file key python" "$(kbkdf_py $KSYNC slate/v2/remote-file "$S11")" $KFILE
KENC=945f11ea9bf4b80dc2ca2f87255998fd341f56c6d9a6fb45a44aa067c1b3f589
KMAC=5ed3ac7f8024fae8e05db04c670e85169ccb2a046814a7cd455d78575be4f36e
expect "KBKDF name-enc openssl kdf" "$(kbkdf $MK slate/v2/name-enc $VID)" $KENC
expect "KBKDF name-mac openssl kdf" "$(kbkdf $MK slate/v2/name-mac $VID)" $KMAC

# HKDF-SHA-256 (suite 0x01) and RFC 5869 TC1
W=50a3fb29a3dcf18020686e7dbad697b06f8c34e9768b73fa611855df1dc9a75c
expect "HKDF v1 sync openssl kdf" "$("$OPENSSL" kdf -keylen 32 -kdfopt digest:SHA256 -kdfopt hexkey:$MK -kdfopt info:slate/v1/sync HKDF | norm)" $W kat
expect "HKDF v1 sync node:crypto" "$(node -e 'process.stdout.write(Buffer.from(require("node:crypto").hkdfSync("sha256", Buffer.from(process.argv[1], "hex"), Buffer.alloc(0), "slate/v1/sync", 32)).toString("hex"))' $MK)" $W
expect "HKDF RFC 5869 TC1 openssl kdf" "$("$OPENSSL" kdf -keylen 42 -kdfopt digest:SHA256 -kdfopt hexkey:$(hexrep 0b 22) -kdfopt hexsalt:000102030405060708090a0b0c -kdfopt hexinfo:f0f1f2f3f4f5f6f7f8f9 HKDF | norm)" \
  3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865

# PBKDF2-HMAC-SHA-512 (SP 800-132)
W=13aaaff0d5b53fa8de2272037363cf3797267e3b583f4127e55a47cf2feb2079
expect "PBKDF2 openssl kdf" "$("$OPENSSL" kdf -keylen 32 -kdfopt digest:SHA512 -kdfopt pass:slate-kat-password -kdfopt hexsalt:$(hexrep 5a 32) -kdfopt iter:1000 PBKDF2 | norm)" $W kat
expect "PBKDF2 python" "$(python3 -c 'import hashlib; print(hashlib.pbkdf2_hmac("sha512", b"slate-kat-password", b"\x5a"*32, 1000, 32).hex())')" $W

# Argon2id v0x13 (RFC 9106): the POST vector and the RFC's own §5.3 vector
W=688b4d6d818d74c8ffa75d1f2439b2ddb829d1ae84814d54944b9740d4909812
expect "Argon2id openssl kdf" "$("$OPENSSL" kdf -keylen 32 -kdfopt pass:slate-kat-password -kdfopt hexsalt:$(hexrep 5a 16) -kdfopt iter:3 -kdfopt memcost:32 -kdfopt lanes:1 ARGON2ID | norm)" $W kat
expect "Argon2id hash-wasm" "$(cd "$repo/packages/desktop" && node -e '
require("hash-wasm").argon2id({ password: "slate-kat-password", salt: new Uint8Array(16).fill(0x5a), iterations: 3, memorySize: 32, parallelism: 1, hashLength: 32, outputType: "hex" }).then((h) => process.stdout.write(h))')" $W
expect "Argon2id RFC 9106 5.3 openssl kdf" "$("$OPENSSL" kdf -keylen 32 -kdfopt hexpass:$(hexrep 01 32) -kdfopt hexsalt:$(hexrep 02 16) -kdfopt hexsecret:$(hexrep 03 8) -kdfopt hexad:$(hexrep 04 12) -kdfopt iter:3 -kdfopt memcost:32 -kdfopt lanes:4 ARGON2ID | norm)" \
  0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659

# SLE2 envelope: AES-256-GCM under the KBKDF file key, AAD = header(38) || "|" || path
W=3a8c6e82f7592e6a3ed5d5f220c3e5f3bb379958c3644102c211aff0aeda9375fff010
expect "SLE2 ct|tag node:crypto" "$(node -e '
const [k, s11, path] = process.argv.slice(1)
const hdr = Buffer.concat([Buffer.from("SLE2"), Buffer.from([2, 0, 0, 0, 0, 0]), Buffer.from(s11, "hex"), Buffer.alloc(12, 0x22)])
const c = require("node:crypto").createCipheriv("aes-256-gcm", Buffer.from(k, "hex"), Buffer.alloc(12, 0x22))
c.setAAD(Buffer.concat([hdr, Buffer.from("|" + path)]))
const ct = Buffer.concat([c.update("slate-kat-plaintext"), c.final()])
process.stdout.write(Buffer.concat([ct, c.getAuthTag()]).toString("hex"))' $KFILE "$S11" docs/page_00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000001.chunk)" $W kat

# Suite 0x02 name (§4.6): SIV = HMAC(K_name_mac, "slate-name/v2" || 00 || P)[0..16), C = AES-256-CTR(K_name_enc, SIV, P)
P=00000000000020008000000000000001
SIV=$(python3 -c 'import hmac,hashlib,sys; print(hmac.new(bytes.fromhex(sys.argv[1]), b"slate-name/v2\0" + bytes.fromhex(sys.argv[2]), hashlib.sha256).hexdigest()[:32])' $KMAC $P)
expect "name SIV python hmac" "$SIV" 50e291505985f76efa7aeb45620bd1b8
expect "name C openssl enc -aes-256-ctr" "$(printf $P | xxd -r -p | "$OPENSSL" enc -aes-256-ctr -K $KENC -iv "$SIV" | xxd -p | norm)" 30101fd8c6a1b6030c339f4eee5ffe9c

# ML-DSA (FIPS 204, pure, context string): each ACVP case, then tcId 43 with one flipped signature bit and with
# another context. The SPKI is the level's fixed RFC 9881 prefix || pk, as in the tests.
mldsa=$(mktemp -d)
trap 'rm -rf "$mldsa"' EXIT
python3 -I - "$here/vectors/mldsa/sigver.h" "$mldsa" <<'PY'
import os, re, sys
src = open(sys.argv[1]).read()
body = src[src.index("MLDSA_SIGVER[] = {"):]
prefix = {65: "308207b2300b0609608648016503040312038207a100", 87: "30820a32300b060960864801650304031303820a2100"}
def put(name, pk_spki, msg, ctx, sig, want):
    d = os.path.join(sys.argv[2], name)
    os.mkdir(d)
    for f, v in (("spki.der", pk_spki), ("msg", msg), ("sig", sig)):
        open(os.path.join(d, f), "wb").write(bytes.fromhex(v))
    open(os.path.join(d, "ctx"), "w").write(ctx)
    open(os.path.join(d, "want"), "w").write(want)
for m in re.finditer(r'\{(\d+), (\d+), ([01]),[^\n]*\n((?:\s*"[0-9a-f]*"\s*,?)+)\}', body):
    pk, msg, ctx, sig = ["".join(re.findall(r'"([0-9a-f]*)"', f)) for f in m.group(4).split(",")[:4]]
    tc, level, ok = m.group(1), int(m.group(2)), m.group(3) == "1"
    spki = prefix[level] + pk
    put(f"{tc:0>3}-ML-DSA-{level}-tcId-{tc}", spki, msg, ctx, sig, "verified" if ok else "failure")
    if tc == "43":
        flipped = sig[:200] + format(int(sig[200:202], 16) ^ 1, "02x") + sig[202:]
        put("043a-tcId-43-flipped-bit", spki, msg, ctx, flipped, "failure")
        other = format(int(ctx[:2], 16) ^ 0x80, "02x") + ctx[2:]
        put("043b-tcId-43-other-context", spki, msg, other, sig, "failure")
PY
for d in "$mldsa"/*/; do
  name=$(basename "$d")
  set -- -verify -rawin -pubin -keyform DER -inkey "$d/spki.der" -in "$d/msg" -sigfile "$d/sig"
  [ -s "$d/ctx" ] && set -- "$@" -pkeyopt "hexcontext-string:$(cat "$d/ctx")"
  if "$OPENSSL" pkeyutl "$@" >/dev/null 2>&1; then got=verified; else got=failure; fi
  expect "ML-DSA $name openssl pkeyutl" "$got" "$(cat "$d/want")"
done
[ "$(ls "$mldsa" | wc -l | tr -d ' ')" -eq 5 ] || { echo "FAIL ML-DSA: expected 5 cases from sigver.h"; fails=$((fails + 1)); }

echo "crossCheck: $fails failure(s)"
[ "$fails" -eq 0 ]
