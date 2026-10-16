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
- Shell scripts (*.sh): every `IMAGE=` / `*_IMAGE=` assignment (plain,
  export/readonly/local/declare/typeset) must carry a digest (a bare name
  means :latest); any other way of setting such a variable is refused. A value that is only a repository name,
  completed with a tag elsewhere, needs an explicit `# pin-check: repository`
  comment on its line. Shell lines must not run `npm install` either.

Forms this checker does not understand are reported as errors, never skipped.
Bump a pin by changing tag and digest (or version comment and SHA) together.
Usage: check_pins.py [repo-root]   (default: current directory)
"""
import json
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
IMAGE_KEY = re.compile(r"""(?:^|[\s{,\[-])(['"]?)(image|container)\1\s*:\s*([^,}\]\n]*)""")
SH_IMAGE = re.compile(r"""^\s*(?:(?:export|readonly|local|declare|typeset)(?:\s+-[A-Za-z]+)*\s+)?"""
                      r"""([A-Za-z_]*IMAGE)=(['"]?)([^'"\s]*)\2(?:\s|;|$)""", re.I)
# Any other way of setting an *IMAGE variable (+=, printf -v, read, ...).
SH_IMAGE_ANY = re.compile(r"""(?:^|[;&|(]\s*)(?:(?:export|readonly|local|declare|typeset)(?:\s+-[A-Za-z]+)*\s+)?"""
                          r"""[A-Za-z_]*IMAGE\+?=|(?:printf\s+-v|\bread\b[^;|&]*)\s+[A-Za-z_]*IMAGE\b""", re.I)
MAPPING_LINE = re.compile(r"""^(-\s|\?\s|['"]?[\w.-]+['"]?\s*:(\s|$))""")


def is_dockerfile(path):
    name = os.path.basename(path)
    low = name.lower()
    return low == "dockerfile" or low.startswith("dockerfile.") or low.endswith(".dockerfile")


def is_workflow(path):
    parts = path.replace(os.sep, "/").split("/")
    if parts[-1] in ("action.yml", "action.yaml"):
        return True
    return parts[0] == ".github" and path.endswith((".yml", ".yaml"))


def runs_npm_install(command, exec_form=False):
    """True if any simple command in `command` is npm with an install verb."""
    body = command.strip()
    if exec_form and body.startswith("["):  # Dockerfile exec form
        try:
            body = " ".join(json.loads(body))
        except ValueError:
            return True  # unparseable: refuse rather than skip
    flat = re.sub(r"\\(.)", r"\1", body)  # shell escapes: inst\all -> install
    flat = re.sub(r"""["']""", "", flat)  # shell quoting: "inst"all -> install
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
        # Docker drops comment lines (and blank lines) even inside a
        # continuation, so they never end an instruction.
        if line.lstrip().startswith("#") or (buf and not line.strip()):
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
        rest = words[1:]
        while rest and rest[0].startswith("--"):
            rest = rest[1:]
        rest = " ".join(rest)
        if instr == "run" and runs_npm_install(rest, exec_form=True):
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
            if rest.startswith("["):
                try:
                    srcs = [str(x) for x in json.loads(rest)][:-1]
                except ValueError:
                    errors.append(f"cannot parse: {line}")
                    continue
            else:
                srcs = rest.split()[:-1]
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


BLOCK_START = re.compile(r"""^(\s*)(?:-\s+)?[\w"'-]+\s*:\s*([|>])[-+0-9]*\s*(?:#.*)?$""")


def yaml_commands(lines):
    """(line number, text) for every line, plus each block scalar decoded
    roughly as the shell sees it: literal blocks keep newlines but join
    backslash continuations; folded blocks join lines with spaces."""
    out = [(n, strip_comment(l)) for n, l in enumerate(lines, 1) if not l.lstrip().startswith("#")]
    i = 0
    while i < len(lines):
        m = BLOCK_START.match(lines[i])
        i += 1
        if not m:
            continue
        start, indent, body = i, len(m.group(1)), []
        while i < len(lines) and (not lines[i].strip() or
                                  len(lines[i]) - len(lines[i].lstrip()) > indent):
            body.append(lines[i].strip())
            i += 1
        text = ("\n" if m.group(2) == "|" else " ").join(body)
        text = re.sub(r"\\\s*\n", " ", text)
        out.append((start, text))
    return out


def check_workflow(text, local_action_exists=lambda ref: True):
    errors = []
    lines = text.splitlines()
    for n, command in yaml_commands(lines):
        if runs_npm_install(command):
            errors.append(f"line {n}: use npm ci, not npm install: {command.strip()[:120]}")
    for n, raw in enumerate(lines, 1):
        if raw.lstrip().startswith("#"):
            continue
        if ESCAPED_KEY.search(raw):
            errors.append(f"line {n}: unsupported quoted key with escapes: {raw.strip()}")
            continue
        for im in IMAGE_KEY.finditer(strip_comment(raw)):
            raw_value = strip_comment(im.group(3))
            if raw_value[:1] in ("&", "*", "!"):
                errors.append(f"line {n}: unsupported YAML anchor/alias/tag on {im.group(2)}: {raw_value}")
                continue
            if raw_value[:1] in ("'", '"') and (len(raw_value) < 2 or raw_value[-1] != raw_value[0]):
                errors.append(f"line {n}: unsupported multi-line quoted {im.group(2)} value")
                continue
            value = unquote(raw_value)
            if raw_value.startswith("{"):
                continue  # flow mapping: its image key is matched by this same loop
            if not value or value[0] in "|>":
                # Value on the following, more-indented lines: a block scalar,
                # a multi-line plain scalar, or (container:) a mapping.
                indent = len(raw) - len(raw.lstrip())
                body = []
                for nxt in lines[n:]:
                    if nxt.strip() and len(nxt) - len(nxt.lstrip()) <= indent:
                        break
                    if nxt.strip():
                        body.append(nxt.strip())
                if not body:
                    continue
                if not value and MAPPING_LINE.match(body[0]):
                    # container: mapping (its image: line is checked itself),
                    # or a job that happens to be named "image".
                    continue
                value = unquote(" ".join(strip_comment(b) for b in body))
            if "${{" in value:
                errors.append(f"line {n}: image from an expression, cannot verify pin: {value}")
            elif (im.group(2) == "image" and value.endswith("Dockerfile")
                  and not value.startswith("docker://")):
                continue  # local Docker action build
            elif not DIGEST.search(value):
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
    lines = text.splitlines()
    # Join backslash continuations so `npm \ install` is one command.
    joined = re.sub(r"\\\n", " ", "\n".join(l for l in lines if not l.lstrip().startswith("#")))
    for command in joined.split("\n"):
        if runs_npm_install(strip_comment(command)):
            errors.append(f"use npm ci, not npm install: {command.strip()[:120]}")
    for n, raw in enumerate(lines, 1):
        if raw.lstrip().startswith("#"):
            continue
        m = SH_IMAGE.match(raw)
        if not m:
            if SH_IMAGE_ANY.search(strip_comment(raw)):
                errors.append(f"line {n}: unsupported way of setting an image variable: {raw.strip()}")
            continue
        value = m.group(3)
        if not value or re.search(r"#\s*pin-check:\s*repository\b", raw):
            continue
        if "$" in value:
            errors.append(f"line {n}: image from a variable, cannot verify pin: {m.group(1)}={value}")
        elif not DIGEST.search(value):
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
    print(f"{checked} files checked: image, frontend and action references pinned, "
          "no npm install (see the script header for exactly what is checked).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
