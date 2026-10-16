"""Install policy for legacy-proxy's image and CI (audit deploy-4, legacy-proxy-10).

Every dependency install must use the lockfile (`npm ci`) with lifecycle
scripts off, so no install script (esbuild's or better-sqlite3's) can fetch a
binary outside the lockfile; better-sqlite3 is then rebuilt from its locked
source tarball against local Node headers. These tests fail if a later edit
drops any part of that.
Run: python3 -m unittest discover -s .github/scripts -p 'test_*.py'
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_pins import logical_lines, yaml_commands  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def read(path):
    with open(os.path.join(REPO, path), encoding="utf-8") as f:
        return f.read()


def npm_commands(text):
    """Each `npm ...` simple command, with the env assignments before it."""
    out = []
    for segment in re.split(r"&&|\|\||;|\n", text):
        m = re.search(r"(?:^|\s)npm\s+(.*)", segment)
        if m:
            out.append((segment[:m.start()], m.group(1).split()))
    return out


def check_policy(commands):
    problems, rebuilt, installed = [], False, False
    for env, args in commands:
        verb = args[0] if args else ""
        if verb == "ci":
            installed = True
            if "--ignore-scripts" not in args:
                problems.append(f"npm ci without --ignore-scripts: {args}")
        elif verb == "rebuild":
            if args[1:] != ["better-sqlite3"]:
                problems.append(f"npm rebuild must name better-sqlite3 only: {args}")
            if "npm_config_build_from_source=better-sqlite3" not in env:
                problems.append("npm rebuild without npm_config_build_from_source=better-sqlite3")
            if "npm_config_nodedir=" not in env:
                problems.append("npm rebuild without npm_config_nodedir (local Node headers)")
            rebuilt = True
        elif verb not in ("cache", "run", "test"):
            problems.append(f"unexpected npm command: {args}")
    return problems, installed, rebuilt


class DockerfilePolicy(unittest.TestCase):
    def setUp(self):
        self.lines = logical_lines(read("Dockerfile"))

    def test_lockfile_is_required(self):
        copies = [l for l in self.lines if l.split()[0].upper() == "COPY" and "package.json" in l]
        self.assertEqual(len(copies), 2)
        for line in copies:
            self.assertIn("package-lock.json", line.split())

    def test_every_install_is_scriptless_and_sqlite_is_built_from_source(self):
        runs = " ; ".join(l for l in self.lines if l.split()[0].upper() == "RUN")
        problems, installed, rebuilt = check_policy(npm_commands(runs))
        self.assertEqual(problems, [])
        self.assertTrue(installed and rebuilt)

    def test_policy_rejects_regressions(self):
        for bad in ("npm ci --no-audit", "npm install", "npm rebuild",
                    "npm_config_nodedir=/usr/local npm rebuild better-sqlite3",
                    "npm_config_build_from_source=better-sqlite3 npm rebuild better-sqlite3"):
            self.assertTrue(check_policy(npm_commands(bad))[0], bad)


class WorkflowPolicy(unittest.TestCase):
    def test_ci_install_is_scriptless_and_sqlite_is_built_from_source(self):
        text = read(".github/workflows/test.yml")
        blocks = [c for _, c in yaml_commands(text.splitlines()) if "npm" in c]
        run = max(blocks, key=len)  # the install block as the shell sees it
        problems, installed, rebuilt = check_policy(
            [c for c in npm_commands(run) if c[1][:1] in (["ci"], ["rebuild"])])
        self.assertEqual(problems, [])
        self.assertTrue(installed and rebuilt)


if __name__ == "__main__":
    unittest.main()
