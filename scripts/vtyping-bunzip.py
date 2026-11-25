"""Decompress one .bz2 file with the Python standard library (stdlib only, no third-party code).

Used by `npm run vtyping:import-tatoeba`. The input is untrusted downloaded data: it is only decompressed to a plain file, never executed.
Run it isolated: py -3.11 -I scripts/vtyping-bunzip.py <input.bz2> <output>
"""
import bz2
import sys

CHUNK = 1 << 20
MAX_BYTES = 3 * (1 << 30)  # refuse a decompression bomb above 3 GiB


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: vtyping-bunzip.py <input.bz2> <output>", file=sys.stderr)
        return 2
    source, target = sys.argv[1], sys.argv[2]
    written = 0
    with bz2.open(source, "rb") as src, open(target, "wb") as dst:
        while True:
            block = src.read(CHUNK)
            if not block:
                break
            written += len(block)
            if written > MAX_BYTES:
                print("output too large, stopping", file=sys.stderr)
                return 1
            dst.write(block)
    print(written)
    return 0


if __name__ == "__main__":
    sys.exit(main())
