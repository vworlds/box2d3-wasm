#!/usr/bin/env python3
"""Check that every function of Box2D's public C API is callable from JavaScript.

    python3 scripts/check_bindings.py        # also: npm run check:bindings

The rule: every `B2_API` function declared in box2d/include/box2d/*.h is bound as an embind
function in src/*.cpp (`function("name", ...)`) or is listed, with a reason, in
scripts/bindings-exceptions.txt. The check fails (exit 1) when

  - a declared function is neither bound nor excepted ("missing"),
  - the exceptions file names a function that is not declared in the headers ("stale exception"),
  - an exception names a function that is also bound ("redundant exception"),
  - an embind binding with a Box2D name (`b2...`) matches no declaration in the headers and is not
    listed as a package-specific extra ("stale binding"),
  - a generated fast-path export (src/fastpath_body.gen.cpp) maps to no declared function.

Exceptions file format, one entry per line, a `# reason` is mandatory:

    b2World_Draw          # debug draw removed        <- declared in Box2D, deliberately not bound
    +b2Body_GetPointer    # package helper, no C twin <- bound by this package, not a Box2D function

The fast path (`B2X_API ... b2x_<Group>_<Name>`) is reported but does not satisfy the rule:
the flat embind API is the complete surface, the fast path is an optional shortcut to it.

Comments and preprocessor lines are stripped before parsing, so commented-out bindings do not
count, and declarations spanning several lines are handled. Only Python 3 is needed.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
INCLUDE = ROOT / "box2d" / "include" / "box2d"
SRC = ROOT / "src"
EXCEPTIONS = pathlib.Path(__file__).resolve().parent / "bindings-exceptions.txt"


def strip_comments(text):
    """Remove /* */ and // comments, leaving string literals alone."""
    out = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append(text[i : j + 1])
            i = j + 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            out.append(" ")
            i = n if j < 0 else j + 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def strip_preprocessor(text):
    """Drop #directive lines, including backslash continuations."""
    out, cont = [], False
    for line in text.split("\n"):
        if cont or line.lstrip().startswith("#"):
            cont = line.rstrip().endswith("\\")
            out.append("")
        else:
            out.append(line)
    return "\n".join(out)


API_RE = re.compile(r"\bB2_API\b([^;{}]*?)\b([A-Za-z_]\w*)\s*\(")
INLINE_RE = re.compile(r"\bB2_(?:FORCE_)?INLINE\b([^;{}(]*?)\b([A-Za-z_]\w*)\s*\(")


def parse_headers():
    api, inline = {}, {}
    for h in sorted(INCLUDE.glob("*.h")):
        text = strip_preprocessor(strip_comments(h.read_text()))
        for m in API_RE.finditer(text):
            api.setdefault(m.group(2), h.name)
        for m in INLINE_RE.finditer(text):
            inline.setdefault(m.group(2), h.name)
    return api, inline


EMBIND_RE = re.compile(r'(?<![\w.])function\s*\(\s*"([^"]+)"')
B2X_RE = re.compile(r"\bB2X_API\b[^;{}]*?\b(b2x_\w+)\s*\(")


def parse_sources():
    embind, b2x = {}, {}
    for f in sorted(SRC.glob("*.cpp")):
        text = strip_comments(f.read_text())
        for m in EMBIND_RE.finditer(text):
            embind.setdefault(m.group(1), f.name)
        for m in B2X_RE.finditer(strip_preprocessor(text)):
            b2x.setdefault(m.group(1), f.name)
    return embind, b2x


def parse_exceptions():
    excepted, extras, errors = {}, {}, []
    if not EXCEPTIONS.exists():
        return excepted, extras, [f"{EXCEPTIONS.name} is missing"]
    for no, raw in enumerate(EXCEPTIONS.read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        name, _, reason = line.partition("#")
        name, reason = name.strip(), reason.strip()
        if not re.fullmatch(r"\+?\w+", name):
            errors.append(f"{EXCEPTIONS.name}:{no}: cannot parse '{raw}'")
        elif not reason:
            errors.append(f"{EXCEPTIONS.name}:{no}: '{name}' has no '# reason'")
        elif name.startswith("+"):
            extras[name[1:]] = reason
        else:
            excepted[name] = reason
    return excepted, extras, errors


def b2x_to_c(name):
    """b2x_Body_GetPosition -> b2Body_GetPosition (None for names without a group)."""
    m = re.fullmatch(r"b2x_([A-Z]\w*?_\w+)", name)
    return "b2" + m.group(1) if m else None


def main():
    api, inline = parse_headers()
    embind, b2x = parse_sources()
    excepted, extras, errors = parse_exceptions()
    declared = set(api)
    known = declared | set(inline)  # inline helpers (math_functions.h) may be bound, never required

    fast = {}
    for n, f in b2x.items():
        c = b2x_to_c(n)
        if c in declared:
            fast[c] = n
        elif f == "fastpath_body.gen.cpp":
            errors.append(f"stale fast-path export: {n} ({f}) maps to no declared function")

    bound = {n for n in embind if n in declared}
    missing = sorted(declared - bound - set(excepted))
    stale_exc = sorted(n for n in excepted if n not in declared)
    redundant = sorted(n for n in excepted if n in bound)
    stale_extra = sorted(n for n in extras if n not in embind)
    unknown = sorted(n for n in embind if re.match(r"b2[A-Z]", n) and n not in known and n not in extras)
    extra_in_headers = sorted(n for n in extras if n in known)

    per_header = {}
    for n, h in api.items():
        d = per_header.setdefault(h, [0, 0, 0, 0])
        d[0] += 1
        d[1] += n in bound
        d[2] += n in fast
        d[3] += n in excepted

    print("header               declared  embind  fastpath  excepted")
    for h in sorted(per_header):
        d = per_header[h]
        print(f"{h:<20} {d[0]:>8} {d[1]:>7} {d[2]:>9} {d[3]:>9}")
    print(
        f"TOTAL declared={len(declared)} bound-by-embind={len(bound)} "
        f"bound-by-fastpath={len(fast)} excepted={len([n for n in excepted if n in declared])} "
        f"package-extras={len(extras)} bound-inline-helpers={len([n for n in embind if n in inline])}"
    )

    def report(title, names):
        if names:
            print(f"\nFAIL {title}:")
            for n in names:
                print(f"  {n}")
        return bool(names)

    failed = False
    failed |= report("declared in the Box2D headers but neither bound nor excepted", missing)
    failed |= report("stale exceptions (no such function in the headers)", stale_exc)
    failed |= report("exceptions that are in fact bound (remove them from the exceptions file)", redundant)
    failed |= report("stale bindings (Box2D-looking name, not declared in the headers; list as +name if intended)", unknown)
    failed |= report("extras (+name) that are not bound", stale_extra)
    failed |= report("extras (+name) that are declared in the headers (drop the +)", extra_in_headers)
    failed |= report("exceptions file problems", errors)
    if failed:
        return 1
    print("OK: every declared function is bound or excepted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
