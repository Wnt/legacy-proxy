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


    def test_npm_install_forms(self):
        for run in ('RUN ["npm", "install", "--omit=dev"]', "RUN npm --prefix /app install",
                    "RUN cd /app; /usr/local/bin/npm isntall", "RUN npm ci || npm add x"):
            self.assertEqual(len(check_dockerfile(f"FROM n@{D}\n{run}\n")), 1, run)
        for run in ('RUN ["npm", "ci"]', "RUN npm uninstall -g npm && npx playwright install",
                    "RUN npm run install-deps"):
            self.assertEqual(check_dockerfile(f"FROM n@{D}\n{run}\n"), [], run)

    def test_npm_install_shell_tricks(self):
        for run in ("RUN npm inst\\all", 'RUN npm "inst"all', "RUN --network=none npm install",
                    'RUN ["npm", "inst', "RUN [\"sh\", \"-c\", \"npm install\"]"):
            self.assertEqual(len(check_dockerfile(f"FROM n@{D}\n{run}\n")), 1, run)

    def test_comment_inside_continuation(self):
        for body in ("RUN true \\\n# install dependencies\n && npm install",
                     "COPY \\\n# helper image\n --from=busybox:latest /bin/sh /sh",
                     "COPY \\\n\n --from=busybox:latest /bin/sh /sh"):
            self.assertEqual(len(check_dockerfile(f"FROM n@{D}\n{body}\n")), 1, body)
        self.assertEqual(check_dockerfile(f"FROM n@{D}\nRUN true \\\n# c\n && npm ci\n"), [])

    def test_escape_directive_refused(self):
        text = f"# escape=`\nFROM node:24@{D}\nRUN echo \\\nFROM node:24\n"
        self.assertTrue(check_dockerfile(text))
        self.assertEqual(check_dockerfile(f"# escape=\\\nFROM node@{D}\n"), [])

    def test_heredoc_and_onbuild_refused(self):
        self.assertEqual(len(check_dockerfile(f"FROM n@{D}\nRUN <<EOF\nnpm install\nEOF\n")), 1)
        self.assertEqual(len(check_dockerfile(f"FROM n@{D}\nONBUILD RUN true\n")), 1)

    def test_copy_from_and_mount_from(self):
        bad = ("COPY --from=busybox:latest /bin/sh /sh",
               "RUN --mount=type=bind,from=busybox:latest,target=/b true",
               "ADD --chown=1 --from=alpine /a /b")
        for line in bad:
            self.assertEqual(len(check_dockerfile(f"FROM n@{D} AS build\n{line}\n")), 1, line)
        good = ("COPY --from=build /a /b", "COPY --from=0 /a /b", f"COPY --from=busybox:1@{D} /a /b",
                "RUN --mount=type=cache,target=/root/.npm npm ci",
                "RUN --mount=type=bind,from=build,target=/b true")
        for line in good:
            self.assertEqual(check_dockerfile(f"FROM n@{D} AS build\n{line}\n"), [], line)

    def test_add_exec_form(self):
        self.assertEqual(len(check_dockerfile(f'FROM n@{D}\nADD ["https://x/p.tgz", "/app/"]\n')), 1)
        self.assertEqual(check_dockerfile(f'FROM n@{D}\nADD ["local.tgz", "/app/"]\n'), [])
        self.assertEqual(len(check_dockerfile(f'FROM n@{D}\nADD ["broken\n')), 1)

    def test_add_remote(self):
        self.assertEqual(len(check_dockerfile(f"FROM n@{D}\nADD https://x/y.tgz /y\n")), 1)
        self.assertEqual(len(check_dockerfile(f"FROM n@{D}\nADD git@github.com:o/r.git /r\n")), 1)
        self.assertEqual(check_dockerfile(f"FROM n@{D}\nADD --checksum=sha256:{'c' * 64} https://x/y /y\n"), [])
        self.assertEqual(check_dockerfile(f"FROM n@{D}\nADD local.tgz /y\n"), [])


class ShellTests(unittest.TestCase):
    def test_image_assignments(self):
        bad = ('PW_IMAGE="mcr.microsoft.com/playwright:v1.59.1-noble"', "export IMAGE=node:24",
               "image='ghcr.io/o/r:latest'", 'PW_IMAGE="x/y@sha256:abc"',
               'PW_IMAGE="mcr.microsoft.com/playwright"', "IMAGE=localhost:5000/o/r", 'IMAGE="$BASE"')
        for line in bad:
            self.assertEqual(len(check_shell(line + "\n")), 1, line)
        good = (f'PW_IMAGE="mcr.microsoft.com/playwright:v1.59.1-noble@{D}"',
                "IMAGE=ghcr.io/o/r  # pin-check: repository (tag appended at use)",
                "echo IMAGE=x:y", "IMAGE=")
        for line in good:
            self.assertEqual(check_shell(line + "\n"), [], line)

    def test_declarations_and_other_assignments(self):
        bad = ('declare -r PW_IMAGE="mcr.microsoft.com/playwright"', "typeset -x IMAGE=node:24",
               "readonly -a X_IMAGE=node", 'PW_IMAGE+=":latest"', "printf -v PW_IMAGE '%s' node",
               "read -r PW_IMAGE < f")
        for line in bad:
            self.assertEqual(len(check_shell(line + "\n")), 1, line)
        self.assertEqual(check_shell(f'declare -r PW_IMAGE="x/y:1@{D}"\n'), [])
        self.assertEqual(check_shell('docker run "$PW_IMAGE" true\n'), [])
        self.assertEqual(len(check_shell('cd x; PW_IMAGE=node:24\n')), 1)

    def test_npm_install_in_scripts(self):
        for body in ("(cd x && npm install --loglevel=warn) &", "npm --ignore-scripts install",
                     "npm \\\n  install"):
            self.assertEqual(len(check_shell(body + "\n")), 1, body)
        for body in ("npm ci --loglevel=warn", "# npm install", 'echo "npm ci + npm run build"'):
            self.assertEqual(check_shell(body + "\n"), [], body)


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

    def test_escaped_quoted_key_refused(self):
        self.assertEqual(len(check_workflow('  - "u\\u0073es": actions/checkout@v7\n')), 1)

    def test_image_keys(self):
        for v in ("node:24", "docker://alpine:latest", "'ghcr.io/o/r:1'", "${{ matrix.image }}"):
            self.assertEqual(len(check_workflow(f"    container:\n      image: {v}\n")), 1, v)
        for v in (f"node:24@{D}", f"docker://alpine:3@{D}", "Dockerfile", "./docker/Dockerfile", ""):
            self.assertEqual(check_workflow(f"    image: {v}\n"), [], v)

    def test_container_shorthand_and_flow_mappings(self):
        for line in ("    container: node:22", "    db: {image: redis:latest}",
                     "    services: { db: { image: 'redis:7' } }", "    container: ${{ matrix.c }}"):
            self.assertEqual(len(check_workflow(line + "\n")), 1, line)
        for line in ("    container:", f"    container: node:22@{D}", f"    db: {{image: redis:7@{D}}}",
                     "    container: # comment"):
            self.assertEqual(check_workflow(line + "\n"), [], line)

    def test_multiline_run_blocks(self):
        for body in ("- run: |\n    npm \\\n      install\n", "- run: >-\n    npm\n    install\n",
                     "- name: x\n  run: |\n    echo hi\n    npm i\n"):
            self.assertTrue(check_workflow(body), body)
        for body in ("- run: |\n    npm ci\n    npx playwright install\n",
                     "- run: |\n    npm ci\n    echo install\n", "- run: >-\n    npm\n    ci\n"):
            self.assertEqual(check_workflow(body), [], body)

    def test_docker_action_remote_tag_named_dockerfile(self):
        self.assertEqual(len(check_workflow("  image: docker://alpine:Dockerfile\n")), 1)
        self.assertEqual(len(check_workflow("runs: {using: docker, image: 'docker://alpine:latest'}\n")), 1)

    def test_multiline_image_values(self):
        bad = ("    container:\n      image: >-\n        node:24\n",
               "    container:\n      image:\n        node:24\n",
               "    container:\n      image: |\n        node:24\n",
               "    container: >-\n      node:24\n",
               '    image: "node:\n      24"\n', "    image: &img node:24\n", "    image: *img\n")
        for body in bad:
            self.assertTrue(check_workflow(body), body)
        good = (f"    container:\n      image: >-\n        node:24@{D}\n",
                f"    container:\n      image:\n        node:24@{D}\n",
                f"    container:\n      image: node:24@{D}\n      options: --user 1001\n",
                f"    services:\n      db:\n        image: redis:7@{D}\n",
                "jobs:\n  image:\n    needs: test\n    runs-on: ubuntu-latest\n")
        for body in good:
            self.assertEqual(check_workflow(body), [], body)

    def test_local_action_must_exist(self):
        self.assertEqual(len(check_workflow("  - uses: ./missing\n", lambda ref: False)), 1)

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
                      {"integration/run.sh": 'PW_IMAGE="mcr.microsoft.com/playwright:v1-noble"\n'},
                      {".github/workflows/c.yml": "- uses: ./actions/local\n",
                       "actions/local/action.yml": "runs:\n  steps:\n    - uses: actions/checkout@v7\n"},
                      {".github/workflows/c.yml": "- uses: ./actions/docker\n",
                       "actions/docker/action.yml": "runs:\n  using: docker\n  image: 'docker://alpine:latest'\n"},
                      {".github/workflows/c.yml": "- uses: ./actions/none\n"}):
            self.assertEqual(self.run_main({**good, **extra}), 1, extra)

    def test_local_actions_pass_when_pinned(self):
        files = {"Dockerfile": f"FROM a@{D}\n",
                 ".github/workflows/a.yml": "- uses: ./actions/x\n- uses: ./.github/workflows/r.yml\n",
                 ".github/workflows/r.yml": f"- uses: o/r@{SHA}\n",
                 "actions/x/action.yml": f"runs:\n  using: docker\n  image: docker://alpine:3@{D}\n"}
        self.assertEqual(self.run_main(files), 0)

    def test_empty_repo_fails(self):
        self.assertEqual(self.run_main({"README": "x"}), 1)


if __name__ == "__main__":
    unittest.main()
