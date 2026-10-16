#!/usr/bin/env python3
"""Fail if a build input is not pinned to immutable content (audit deploy-4).

- Dockerfiles (Dockerfile, Dockerfile.*, *.Dockerfile, *.dockerfile): the
  `# syntax=` frontend and every external FROM image must be
  `<image>:<tag>@sha256:<64 hex>`. `scratch` and earlier stage names are fine.
- GitHub workflows and local actions (.github/**/*.yml|*.yaml): every
  `uses:` must be a local path (./...), a full 40-hex commit SHA
  (owner/repo[/path]@<sha>), or `docker://...@sha256:<64 hex>`.

- Dockerfile RUN lines and workflow lines must not use `npm install` / `npm i`
  (use `npm ci`, which installs exactly the lockfile).
- Shell scripts (*.sh): an `IMAGE=` / `*_IMAGE=` assignment whose value carries
  a tag must also carry a digest.

Forms this checker does not understand are reported as errors, never skipped.
Bump a pin by changing tag and digest (or version comment and SHA) together.
Usage: check_pins.py [repo-root]   (default: current directory)
"""
import os
import re
import subprocess
import sys

DIGEST = re.compile(r"@sha256:[0-9a-f]{64}$")
SHA_REF = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[^@\s]+)?@[0-9a-f]{40}$")
DIRECTIVE = re.compile(r"^#\s*([A-Za-z]+)\s*=\s*(.*?)\s*$")
USES_ANYWHERE = re.compile(r"""(^|[\s{,'"])uses['"]?\s*:""")
USES_LINE = re.compile(r"""^\s*(?:-\s+)?(['"]?)uses\1\s*:\s*(.*)$""")
NPM_INSTALL = re.compile(r"\bnpm\s+(install|i|add)\b")
SH_IMAGE = re.compile(r"""^\s*(?:export\s+|readonly\s+|local\s+)?([A-Za-z_]*IMAGE)=(['"]?)([^'"\s]*)\2""", re.I)


def is_dockerfile(path):
    name = os.path.basename(path)
    low = name.lower()
    return low == "dockerfile" or low.startswith("dockerfile.") or low.endswith(".dockerfile")


def is_workflow(path):
    parts = path.replace(os.sep, "/").split("/")
    return parts[0] == ".github" and path.endswith((".yml", ".yaml"))


def logical_lines(text):
    """Dockerfile lines with backslash continuations joined; comments dropped."""
    out, buf = [], ""
    for raw in text.splitlines():
        line = raw.rstrip()
        if not buf and line.lstrip().startswith("#"):
            continue
        if line.endswith("\\"):
            buf += line[:-1] + " "
            continue
        buf += line
        if buf.strip():
            out.append(buf.strip())
        buf = ""
    if buf.strip():
        out.append(buf.strip())
    return out


def check_dockerfile(text):
    errors = []
    # Parser directives: leading `# key=value` comments before anything else.
    for raw in text.splitlines():
        m = DIRECTIVE.match(raw.strip())
        if not m:
            break
        if m.group(1).lower() == "syntax" and not DIGEST.search(m.group(2)):
            errors.append(f"syntax frontend not pinned by digest: {m.group(2)}")
    stages = set()
    for line in logical_lines(text):
        words = line.split()
        if words[0].lower() == "run" and NPM_INSTALL.search(line):
            errors.append(f"use npm ci, not npm install: {line}")
        if words[0].lower() != "from":
            continue
        args = [w for w in words[1:] if not w.startswith("--")]
        if not args:
            errors.append(f"cannot parse: {line}")
            continue
        image, alias = args[0], None
        if len(args) == 3 and args[1].lower() == "as":
            alias = args[2].lower()
        elif len(args) != 1:
            errors.append(f"cannot parse: {line}")
            continue
        if image.lower() == "scratch" or image.lower() in stages:
            pass  # not an external image
        elif "$" in image:
            errors.append(f"FROM image uses a variable, cannot verify pin: {line}")
        elif not DIGEST.search(image):
            errors.append(f"FROM image not pinned by digest: {image}")
        if alias:
            stages.add(alias)
    return errors


def strip_comment(value):
    return re.split(r"\s+#", value, maxsplit=1)[0].strip()


def check_workflow(text):
    errors = []
    for n, raw in enumerate(text.splitlines(), 1):
        if raw.lstrip().startswith("#"):
            continue
        if NPM_INSTALL.search(strip_comment(raw)):
            errors.append(f"line {n}: use npm ci, not npm install: {raw.strip()}")
        if not USES_ANYWHERE.search(raw):
            continue
        m = USES_LINE.match(raw)
        if not m:
            errors.append(f"line {n}: unsupported 'uses' form: {raw.strip()}")
            continue
        ref = strip_comment(m.group(2))
        if len(ref) >= 2 and ref[0] == ref[-1] and ref[0] in "'\"":
            ref = ref[1:-1].strip()
        if ref.startswith("./"):
            continue
        if ref.startswith("docker://"):
            if not DIGEST.search(ref):
                errors.append(f"line {n}: docker action not pinned by digest: {ref}")
            continue
        if not SHA_REF.match(ref):
            errors.append(f"line {n}: action not pinned to a full commit SHA: {ref or '(empty)'}")
    return errors


def check_shell(text):
    errors = []
    for n, raw in enumerate(text.splitlines(), 1):
        m = SH_IMAGE.match(raw)
        if not m:
            continue
        value = m.group(3)
        has_tag = ":" in value.rsplit("/", 1)[-1]
        if (has_tag or "@" in value) and not DIGEST.search(value):
            errors.append(f"line {n}: image not pinned by digest: {m.group(1)}={value}")
    return errors


def tracked_files(root):
    out = subprocess.run(["git", "-C", root, "ls-files", "-z"], check=True,
                         capture_output=True).stdout.decode()
    return [p for p in out.split("\0") if p]


def main(argv):
    root = argv[1] if len(argv) > 1 else "."
    failures = 0
    checked = 0
    for path in tracked_files(root):
        if is_dockerfile(path):
            check = check_dockerfile
        elif is_workflow(path):
            check = check_workflow
        elif path.endswith(".sh"):
            check = check_shell
        else:
            continue
        with open(os.path.join(root, path), encoding="utf-8") as f:
            errors = check(f.read())
        checked += 1
        for e in errors:
            print(f"{path}: {e}")
            failures += 1
    if checked == 0:
        print("no Dockerfiles or workflows found; is this the repo root?")
        return 1
    if failures:
        print(f"{failures} unpinned build input(s); pin images as tag@sha256:<digest> "
              "and actions to a full commit SHA (with a # vX.Y.Z comment).")
        return 1
    print(f"{checked} files checked; all build inputs pinned.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
