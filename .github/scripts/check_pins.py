#!/usr/bin/env python3
"""Fail if a build input is not pinned to immutable content (audit deploy-4).

- Dockerfiles (Dockerfile, Dockerfile.*, *.Dockerfile, *.dockerfile): the
  `# syntax=` frontend, every external FROM image and every external
  `COPY --from=` / `RUN --mount=...from=` image must be
  `<image>:<tag>@sha256:<64 hex>`. `scratch` and earlier stages are fine.
  `ADD` from a URL needs `--checksum=`; ADD from git is refused. An `escape`
  directive, heredocs and ONBUILD are refused (not parsed).
- YAML under .github/ and every action.yml/action.yaml: every `uses:` must be
  a local path (./..., whose action metadata must exist in the repo and is
  checked too), a full 40-hex commit SHA (owner/repo[/path]@<sha>), or
  `docker://...@sha256:<64 hex>`; every `image:` value must be digest-pinned
  (or a local Dockerfile path). Quoted keys with escapes are refused.
- Dockerfile RUN lines and workflow lines must not run `npm install` (or its
  aliases), with or without npm options in between; use `npm ci`, which
  installs exactly the lockfile.
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
NPM_INSTALL_ALIASES = {"install", "i", "in", "ins", "inst", "insta", "instal", "isnt",
                       "isnta", "isntal", "isntall", "add"}
SEGMENT_SPLIT = re.compile(r"&&|\|\||[;|&()`\n]")
ESCAPED_KEY = re.compile(r"""(^|[\s{,\[-])"[^"]*\\[^"]*"\s*:""")
IMAGE_KEY = re.compile(r"""^\s*(?:-\s+)?(['"]?)image\1\s*:\s*(.*)$""")
SH_IMAGE = re.compile(r"""^\s*(?:export\s+|readonly\s+|local\s+)?([A-Za-z_]*IMAGE)=(['"]?)([^'"\s]*)\2""", re.I)


def is_dockerfile(path):
    name = os.path.basename(path)
    low = name.lower()
    return low == "dockerfile" or low.startswith("dockerfile.") or low.endswith(".dockerfile")


def is_workflow(path):
    parts = path.replace(os.sep, "/").split("/")
    if parts[-1] in ("action.yml", "action.yaml"):
        return True
    return parts[0] == ".github" and path.endswith((".yml", ".yaml"))


def runs_npm_install(command):
    """True if any simple command in `command` is npm with an install verb."""
    flat = re.sub(r"""[\[\]",']""", " ", command)  # exec form / quoting
    for segment in SEGMENT_SPLIT.split(flat):
        tokens = segment.split()
        for i, tok in enumerate(tokens):
            if tok == "npm" or tok.endswith("/npm"):
                if any(t in NPM_INSTALL_ALIASES for t in tokens[i + 1:]):
                    return True
    return False


def external_ref_error(kind, ref, stages):
    if ref.lower() in stages or ref.isdigit() or ref.lower() == "scratch":
        return None
    if "$" in ref:
        return f"{kind} uses a variable, cannot verify pin: {ref}"
    if not DIGEST.search(ref):
        return f"{kind} not pinned by digest: {ref}"
    return None


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
        key = m.group(1).lower()
        if key == "syntax" and not DIGEST.search(m.group(2)):
            errors.append(f"syntax frontend not pinned by digest: {m.group(2)}")
        if key == "escape" and m.group(2) != "\\":
            errors.append("unsupported escape directive (this checker only parses \\)")
    stages = set()
    for line in logical_lines(text):
        words = line.split()
        instr = words[0].lower()
        if instr == "onbuild":
            errors.append(f"unsupported ONBUILD: {line}")
            continue
        if instr in ("run", "copy", "add") and re.search(r"<<-?\s*['\"]?\w", line):
            errors.append(f"unsupported heredoc: {line}")
            continue
        if instr == "run" and runs_npm_install(line):
            errors.append(f"use npm ci, not npm install: {line}")
        if instr in ("copy", "add", "run"):
            for w in words[1:]:
                if not w.startswith("--"):
                    break
                m = re.match(r"--from=(.+)$", w)
                if m and instr in ("copy", "add"):
                    e = external_ref_error("COPY --from image", m.group(1), stages)
                    if e:
                        errors.append(e)
                if w.startswith("--mount="):
                    m = re.search(r"(?:^|,)from=([^,]+)", w[len("--mount="):])
                    if m:
                        e = external_ref_error("RUN --mount from image", m.group(1), stages)
                        if e:
                            errors.append(e)
        if instr == "add":
            srcs = [w for w in words[1:] if not w.startswith("--")][:-1]
            for src in srcs:
                if re.match(r"(git@|git://|ssh://)", src) or src.endswith(".git") or "github.com/" in src and "#" in src:
                    errors.append(f"ADD from git is not pinned by content: {src}")
                elif re.match(r"https?://", src) and not any(w.startswith("--checksum=sha256:") for w in words):
                    errors.append(f"ADD from URL needs --checksum=sha256:...: {src}")
        if instr != "from":
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
        if image.isdigit():
            errors.append(f"cannot parse: {line}")
        else:
            e = external_ref_error("FROM image", image, stages)
            if e:
                errors.append(e)
        if alias:
            stages.add(alias)
    return errors


def strip_comment(value):
    return re.split(r"\s+#", value, maxsplit=1)[0].strip()


def unquote(value):
    value = strip_comment(value)
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1].strip()
    return value


def check_workflow(text, local_action_exists=lambda ref: True):
    errors = []
    for n, raw in enumerate(text.splitlines(), 1):
        if raw.lstrip().startswith("#"):
            continue
        if runs_npm_install(strip_comment(raw)):
            errors.append(f"line {n}: use npm ci, not npm install: {raw.strip()}")
        if ESCAPED_KEY.search(raw):
            errors.append(f"line {n}: unsupported quoted key with escapes: {raw.strip()}")
            continue
        im = IMAGE_KEY.match(raw)
        if im:
            value = unquote(im.group(2))
            if "${{" in value:
                errors.append(f"line {n}: image from an expression, cannot verify pin: {value}")
            elif value and not value.endswith("Dockerfile") and not DIGEST.search(value):
                errors.append(f"line {n}: image not pinned by digest: {value}")
        if not USES_ANYWHERE.search(raw):
            continue
        m = USES_LINE.match(raw)
        if not m:
            errors.append(f"line {n}: unsupported 'uses' form: {raw.strip()}")
            continue
        ref = unquote(m.group(2))
        if ref.startswith("./"):
            if not local_action_exists(ref):
                errors.append(f"line {n}: local action/workflow not found in the repo: {ref}")
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
    files = tracked_files(root)
    tracked = set(files)

    def local_action_exists(ref):
        target = os.path.normpath(ref[2:]).replace(os.sep, "/")
        if target.endswith((".yml", ".yaml")):
            return target in tracked  # local reusable workflow, checked itself
        return f"{target}/action.yml" in tracked or f"{target}/action.yaml" in tracked

    for path in files:
        if is_dockerfile(path):
            check = check_dockerfile
        elif is_workflow(path):
            def check(text):
                return check_workflow(text, local_action_exists)
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
