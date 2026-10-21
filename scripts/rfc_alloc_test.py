#!/usr/bin/env python3
"""Allocator tests. Run from the repo root: python3 scripts/rfc_alloc_test.py"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import importlib.util


def load_alloc():
    path = Path(__file__).with_name("rfc_alloc.py")
    spec = importlib.util.spec_from_file_location("rfc_alloc", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


alloc = load_alloc()


class NextNumber(unittest.TestCase):
    def test_does_not_fill_gaps(self) -> None:
        self.assertEqual(alloc.next_number({1, 2, 4}), 5)

    def test_empty_starts_at_zero(self) -> None:
        self.assertEqual(alloc.next_number(set()), 0)

    def test_restored_low_numbers_do_not_lower_the_next(self) -> None:
        self.assertEqual(alloc.next_number(set(range(0, 70))), 70)


class Collect(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.rfc = self.root / "docs" / "rfcs"
        self.rfc.mkdir(parents=True)
        self._git(["init", "-q", "-b", "main"])
        self._git(["config", "user.email", "test@example.com"])
        self._git(["config", "user.name", "test"])

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _git(self, args: list[str]) -> None:
        subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True, text=True)

    def _commit_rfc(self, name: str, body: str = "# RFC\n") -> None:
        path = self.rfc / name
        path.write_text(body)
        self._git(["add", f"docs/rfcs/{name}"])
        self._git(["commit", "-q", "-m", f"add {name}"])

    def test_sees_a_number_claimed_only_on_another_branch(self) -> None:
        self._commit_rfc("001-one.md")
        self._git(["checkout", "-q", "-b", "rfc-010-future"])
        self._commit_rfc("010-future.md")
        self._git(["checkout", "-q", "main"])
        self.assertFalse((self.rfc / "010-future.md").exists())
        taken = alloc.taken_numbers(alloc.claims(self.root))
        self.assertIn(1, taken)
        self.assertIn(10, taken)
        self.assertEqual(alloc.next_number(taken), 11)

    def test_branch_name_reserves_a_number_before_the_file_exists(self) -> None:
        self._commit_rfc("001-one.md")
        self._git(["branch", "rfc-008-promised"])
        taken = alloc.taken_numbers(alloc.claims(self.root))
        self.assertIn(8, taken)
        self.assertEqual(alloc.next_number(taken), 9)

    def test_index_row_reserves_a_number(self) -> None:
        (self.rfc / "README.md").write_text("| 004 | [Missing](004-missing.md) | Draft |\n")
        taken = alloc.taken_numbers(alloc.claims(self.root))
        self.assertIn(4, taken)

    def test_promise_reserves_a_number(self) -> None:
        (self.rfc / "001-one.md").write_text("RFC-007 will cover the follow-up.\n")
        taken = alloc.taken_numbers(alloc.claims(self.root))
        self.assertIn(1, taken)
        self.assertIn(7, taken)
        self.assertEqual(alloc.next_number(taken), 8)

    def test_allocate_refuses_a_collision(self) -> None:
        (self.rfc / "003-a.md").write_text("# a\n")
        (self.rfc / "003-b.md").write_text("# b\n")
        n, errors = alloc.allocate(self.root)
        self.assertEqual(n, -1)
        self.assertTrue(any("more than one file" in e for e in errors))

    def test_allocate_prints_the_next_free_number(self) -> None:
        self._commit_rfc("002-two.md")
        (self.rfc / "069-later.md").write_text("# later\n")
        n, errors = alloc.allocate(self.root)
        self.assertEqual(errors, [])
        self.assertEqual(n, 70)


class ShellRefuses(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        repo = Path(__file__).resolve().parents[1]
        script_src = repo / "scripts" / "new-rfc.sh"
        alloc_src = repo / "scripts" / "rfc_alloc.py"
        template_src = repo / "docs" / "rfcs" / "_template.md"
        (self.root / "scripts").mkdir()
        (self.root / "docs" / "rfcs").mkdir(parents=True)
        shutil.copy(script_src, self.root / "scripts" / "new-rfc.sh")
        shutil.copy(alloc_src, self.root / "scripts" / "rfc_alloc.py")
        shutil.copy(template_src, self.root / "docs" / "rfcs" / "_template.md")
        os.chmod(self.root / "scripts" / "new-rfc.sh", 0o755)
        subprocess.run(["git", "-C", str(self.root), "init", "-q", "-b", "main"], check=True)
        subprocess.run(["git", "-C", str(self.root), "config", "user.email", "test@example.com"], check=True)
        subprocess.run(["git", "-C", str(self.root), "config", "user.name", "test"], check=True)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_fetch_failure_refuses_to_allocate(self) -> None:
        (self.root / "docs" / "rfcs" / "001-one.md").write_text("# one\n")
        proc = subprocess.run(
            ["bash", "scripts/new-rfc.sh", "next-one"],
            cwd=self.root,
            text=True,
            capture_output=True,
        )
        self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("refusing", (proc.stderr + proc.stdout).lower())
        self.assertFalse((self.root / "docs" / "rfcs" / "002-next-one.md").exists())

    def test_script_writes_the_next_number_and_will_not_reuse_it(self) -> None:
        bare = Path(self.tmp.name) / "origin.git"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(bare)], check=True)
        subprocess.run(["git", "-C", str(self.root), "remote", "add", "origin", str(bare)], check=True)
        rfc = self.root / "docs" / "rfcs"
        (rfc / "001-one.md").write_text("# one\n")
        (rfc / "README.md").write_text("| 001 | [One](001-one.md) | Draft |\n")
        subprocess.run(["git", "-C", str(self.root), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.root), "commit", "-q", "-m", "init"], check=True)
        subprocess.run(["git", "-C", str(self.root), "push", "-q", "-u", "origin", "main"], check=True)
        # A second clone claims 005 on a branch the first must see after fetch.
        other = Path(self.tmp.name) / "other"
        subprocess.run(["git", "clone", "-q", str(bare), str(other)], check=True)
        subprocess.run(["git", "-C", str(other), "config", "user.email", "test@example.com"], check=True)
        subprocess.run(["git", "-C", str(other), "config", "user.name", "test"], check=True)
        subprocess.run(["git", "-C", str(other), "checkout", "-q", "-b", "rfc-005-other"], check=True)
        (other / "docs" / "rfcs" / "005-other.md").write_text("# other\n")
        subprocess.run(["git", "-C", str(other), "add", "."], check=True)
        subprocess.run(["git", "-C", str(other), "commit", "-q", "-m", "claim 005"], check=True)
        subprocess.run(["git", "-C", str(other), "push", "-q", "-u", "origin", "rfc-005-other"], check=True)

        proc = subprocess.run(
            ["bash", "scripts/new-rfc.sh", "from-script"],
            cwd=self.root,
            text=True,
            capture_output=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertTrue((rfc / "006-from-script.md").is_file(), proc.stdout + proc.stderr)
        self.assertFalse(list(rfc.glob("005-*.md")))
        text = (rfc / "006-from-script.md").read_text()
        self.assertIn("RFC-006", text)
        # The same slug again takes the next number. It must not overwrite 006.
        proc2 = subprocess.run(
            ["bash", "scripts/new-rfc.sh", "again"],
            cwd=self.root,
            text=True,
            capture_output=True,
        )
        self.assertEqual(proc2.returncode, 0, proc2.stdout + proc2.stderr)
        self.assertTrue((rfc / "007-again.md").is_file(), proc2.stdout + proc2.stderr)
        self.assertIn("RFC-006", (rfc / "006-from-script.md").read_text())


if __name__ == "__main__":
    unittest.main()
