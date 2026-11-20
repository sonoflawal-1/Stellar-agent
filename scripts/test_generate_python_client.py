#!/usr/bin/env python3
"""Golden checks for generate-python-client.py (no stellar CLI required)."""
import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
GEN = ROOT / "scripts" / "generate-python-client.py"


def load_module():
    spec = importlib.util.spec_from_file_location("gen_py", GEN)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


class GeneratorGolden(unittest.TestCase):
    def test_normalize_type_name_stable(self):
        mod = load_module()
        self.assertEqual(mod.normalize_type_name("ScvBool"), "Bool")

    def test_pyproject_exists(self):
        self.assertTrue((ROOT / "python" / "pyproject.toml").is_file())


if __name__ == "__main__":
    sys.exit(unittest.main())