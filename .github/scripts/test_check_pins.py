"""Tests for check_pins.py: python3 -m unittest discover -s .github/scripts"""
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_pins import check_dockerfile, check_shell, check_workflow, main  # noqa: E402

D = "sha256:" + "a" * 64
SHA = "b" * 40


class DockerfileTests(unittest.TestCase):
    def test_pinned_passes(self):
        text = (f"# syntax=docker/dockerfile:1.27.1@{D}\n"
                f"FROM --platform=$BUILDPLATFORM node:24-alpine@{D} AS build\n"
                "RUN true\n"
                f"FROM nginx:1.30@{D}\n"
                "COPY --from=build /a /b\n")
        self.assertEqual(check_dockerfile(text), [])

    def test_stage_and_scratch_pass(self):
        text = f"FROM node:24@{D} AS base\nFROM base AS test\nFROM Base\nFROM scratch\n"
        self.assertEqual(check_dockerfile(text), [])

    def test_stage_must_be_declared_earlier(self):
        text = f"FROM later\nFROM node:24@{D} AS later\n"
        self.assertEqual(len(check_dockerfile(text)), 1)

    def test_unpinned_from(self):
        self.assertEqual(len(check_dockerfile("FROM node:24-alpine\n")), 1)

    def test_lowercase_from(self):
        self.assertEqual(len(check_dockerfile(f"FROM node:24@{D}\nfrom node:24 AS x\n")), 1)

    def test_from_with_continuation(self):
        self.assertEqual(len(check_dockerfile("FROM \\\n  node:24 AS x\n")), 1)

    def test_digest_in_wrong_token(self):
        self.assertEqual(len(check_dockerfile(f"FROM node:24 AS x{D}\n")), 1)

    def test_variable_image(self):
        self.assertEqual(len(check_dockerfile(f"ARG IMG=node@{D}\nFROM $IMG\n")), 1)

    def test_syntax_variants(self):
        for line in ("# syntax=docker/dockerfile:1", "# syntax = docker/dockerfile:1",
                     "#SYNTAX=docker/dockerfile:1", "#  syntax  =docker/dockerfile:1"):
            self.assertEqual(len(check_dockerfile(f"{line}\nFROM node@{D}\n")), 1, line)

    def test_syntax_after_instruction_is_comment(self):
        self.assertEqual(check_dockerfile(f"FROM node@{D}\n# syntax=docker/dockerfile:1\n"), [])

    def test_unparseable_from(self):
        self.assertEqual(len(check_dockerfile(f"FROM node@{D} extra words\n")), 1)


    def test_npm_install_rejected(self):
        for run in ("RUN npm install", "run npm i --omit=dev", "RUN apk add x \\\n && npm install"):
            self.assertEqual(len(check_dockerfile(f"FROM n@{D}\n{run}\n")), 1, run)
        self.assertEqual(check_dockerfile(f"FROM n@{D}\nRUN npm ci && npx playwright install\n"), [])


class ShellTests(unittest.TestCase):
    def test_image_assignments(self):
        bad = ('PW_IMAGE="mcr.microsoft.com/playwright:v1.59.1-noble"', "export IMAGE=node:24",
               "image='ghcr.io/o/r:latest'", 'PW_IMAGE="x/y@sha256:abc"')
        for line in bad:
            self.assertEqual(len(check_shell(line + "\n")), 1, line)
        good = (f'PW_IMAGE="mcr.microsoft.com/playwright:v1.59.1-noble@{D}"', "IMAGE=ghcr.io/o/r",
                "IMAGE=localhost:5000/o/r", "echo IMAGE=x:y")
        for line in good:
            self.assertEqual(check_shell(line + "\n"), [], line)


class WorkflowTests(unittest.TestCase):
    def test_npm_install_rejected(self):
        self.assertEqual(len(check_workflow("      - run: npm install\n")), 1)
        self.assertEqual(check_workflow("# npm install in a comment\n      - run: npm ci  # not npm install\n"), [])

    def test_pinned_forms_pass(self):
        text = (f"steps:\n  - uses: actions/checkout@{SHA} # v4.4.0\n"
                f"  - name: x\n    uses: \"github/codeql-action/init@{SHA}\"\n"
                f"  - uses: 'docker://alpine:3@{D}'\n"
                "  - uses: ./.github/actions/local\n"
                "  # - uses: actions/checkout@v4\n"
                "  - run: echo hi\n")
        self.assertEqual(check_workflow(text), [])

    def test_tag_rejected(self):
        for ref in ("actions/checkout@v4", "'actions/checkout@v4'", "actions/checkout@main",
                    f"actions/checkout@{SHA[:39]}", f"actions/checkout@{SHA}x", "docker://alpine:3", ""):
            self.assertEqual(len(check_workflow(f"  - uses: {ref}\n")), 1, ref)

    def test_quoted_key_rejected_when_unpinned(self):
        self.assertEqual(len(check_workflow('  - "uses": actions/checkout@v4\n')), 1)

    def test_flow_style_is_reported(self):
        self.assertEqual(len(check_workflow("steps: [{uses: actions/checkout@v4}]\n")), 1)

    def test_reusable_workflow(self):
        self.assertEqual(len(check_workflow("jobs:\n  a:\n    uses: o/r/.github/workflows/x.yml@v1\n")), 1)
        self.assertEqual(check_workflow(f"jobs:\n  a:\n    uses: o/r/.github/workflows/x.yml@{SHA}\n"), [])


class DiscoveryTests(unittest.TestCase):
    def repo(self, files):
        d = tempfile.mkdtemp()
        for path, text in files.items():
            os.makedirs(os.path.join(d, os.path.dirname(path)), exist_ok=True)
            with open(os.path.join(d, path), "w") as f:
                f.write(text)
        subprocess.run(["git", "init", "-q", d], check=True)
        subprocess.run(["git", "-C", d, "add", "-A"], check=True)
        return d

    def run_main(self, files):
        with open(os.devnull, "w") as null:
            old, sys.stdout = sys.stdout, null
            try:
                return main(["check_pins.py", self.repo(files)])
            finally:
                sys.stdout = old

    def test_finds_all_file_kinds(self):
        good = {"Dockerfile": f"FROM a@{D}\n", ".github/workflows/a.yml": f"- uses: o/r@{SHA}\n"}
        self.assertEqual(self.run_main(good), 0)
        for extra in ({"x/web.Dockerfile": "FROM node\n"}, {"Dockerfile.lite": "FROM node\n"},
                      {"x/app.dockerfile": "FROM node\n"},
                      {".github/workflows/b.yaml": "- uses: o/r@v1\n"},
                      {".github/actions/x/action.yml": "runs:\n  steps:\n    - uses: o/r@v1\n"},
                      {"integration/run.sh": 'PW_IMAGE="mcr.microsoft.com/playwright:v1-noble"\n'}):
            self.assertEqual(self.run_main({**good, **extra}), 1, extra)

    def test_empty_repo_fails(self):
        self.assertEqual(self.run_main({"README": "x"}), 1)


if __name__ == "__main__":
    unittest.main()
