#!/usr/bin/env python3
"""RFC-034: the update script refuses the wrong branch and edits config in place."""
from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "update-mac-host.sh"


def git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True)


class ConfigOnly(unittest.TestCase):
    def test_bind_and_rotate_keep_the_file_private(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text(json.dumps({"hostToken": "secret", "bindHost": "0.0.0.0", "keep": 1}) + "\n")
            os.chmod(path, 0o644)
            proc = subprocess.run(
                ["bash", str(SCRIPT), "--bind-auto", "--rotate-token", "--config-only"],
                env={**os.environ, "GROK_DISPATCH_CONFIG": str(path)},
                text=True,
                capture_output=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            cfg = json.loads(path.read_text())
            self.assertEqual(cfg["bindHost"], "auto")
            self.assertNotIn("hostToken", cfg)
            self.assertEqual(cfg["keep"], 1)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)


class GitGuards(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.parent = Path(self.tmp.name)
        seed = self.parent / "seed"
        seed.mkdir()
        subprocess.run(["git", "-C", str(seed), "init", "-q", "-b", "main"], check=True)
        git(seed, "config", "user.email", "test@example.com")
        git(seed, "config", "user.name", "test")
        (seed / "host").mkdir()
        (seed / "host" / "package.json").write_text("{}\n")
        git(seed, "add", ".")
        git(seed, "commit", "-q", "-m", "init")
        bare = self.parent / "origin.git"
        subprocess.run(["git", "clone", "-q", "--bare", str(seed), str(bare)], check=True)
        self.work = self.parent / "work"
        subprocess.run(["git", "clone", "-q", str(bare), str(self.work)], check=True)
        git(self.work, "config", "user.email", "test@example.com")
        git(self.work, "config", "user.name", "test")
        git(self.work, "checkout", "-q", "-B", "host-install", "--track", "origin/main")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_script(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(SCRIPT), *args],
            env={**os.environ, "UPDATE_MAC_HOST_ROOT": str(self.work)},
            text=True,
            capture_output=True,
        )

    def test_plan_on_origin_main(self) -> None:
        proc = self.run_script("--plan")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("fast-forward origin/main", proc.stdout)
        self.assertIn("build host", proc.stdout)
        self.assertIn("restart service", proc.stdout)
        self.assertNotIn("bindHost", proc.stdout)
        self.assertNotIn("rotate", proc.stdout)

    def test_plan_mentions_optional_flags(self) -> None:
        proc = self.run_script("--plan", "--bind-auto", "--rotate-token")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("bindHost auto", proc.stdout)
        self.assertIn("rotate token", proc.stdout)

    def test_refuses_a_feature_branch(self) -> None:
        git(self.work, "checkout", "-q", "-b", "feature")
        git(self.work, "push", "-q", "-u", "origin", "feature")
        proc = self.run_script("--plan")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("origin/main", proc.stderr)
        self.assertNotIn("fast-forward", proc.stdout)

    def test_refuses_a_dirty_tree(self) -> None:
        (self.work / "host" / "package.json").write_text('{"dirty":true}\n')
        proc = self.run_script("--plan")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("uncommitted", proc.stderr)
        self.assertNotIn("fast-forward", proc.stdout)


if __name__ == "__main__":
    unittest.main()
