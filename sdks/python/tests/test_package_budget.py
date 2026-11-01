"""Size budgets. They fail CI when the package grows past what a small client should weigh.

Raise a budget on purpose, in the same change that adds the weight, and say why in the commit.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import time
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

WHEEL_BUDGET_BYTES = 48 * 1024  # compressed wheel (0.1.0 was 31 KB)
SOURCE_BUDGET_BYTES = 150 * 1024  # installed .py source (0.1.0 was 83 KB)
IMPORT_BUDGET_SECONDS = 1.5  # best of three cold interpreter starts: `python -c "import mitra"`
RUNTIME_DEPENDENCIES = {"httpx", "pydantic"}


@pytest.fixture(scope="module")
def wheel(tmp_path_factory: pytest.TempPathFactory) -> Path:
    import hatchling.build as hatchling  # a dev dependency: the budget must not skip silently

    out = tmp_path_factory.mktemp("wheel")
    here = os.getcwd()
    os.chdir(ROOT)
    try:
        name = hatchling.build_wheel(str(out))
    finally:
        os.chdir(here)
    return out / name


def test_wheel_stays_small_and_ships_only_the_package(wheel: Path):
    assert wheel.stat().st_size <= WHEEL_BUDGET_BYTES
    names = zipfile.ZipFile(wheel).namelist()
    assert all(n.startswith(("mitra/", "mitra_sdk-")) for n in names), names
    assert not any("test" in n or n.endswith((".map", ".pyc")) for n in names), names


def test_source_stays_small():
    total = sum(p.stat().st_size for p in (ROOT / "src" / "mitra").rglob("*.py"))
    assert total <= SOURCE_BUDGET_BYTES


def test_runtime_dependencies_are_only_httpx_and_pydantic():
    text = (ROOT / "pyproject.toml").read_text()
    block = re.search(r"^dependencies = \[(.*?)\]", text, re.S | re.M)
    assert block
    names = {re.match(r"[A-Za-z0-9_.-]+", d).group(0).lower() for d in re.findall(r'"([^"]+)"', block.group(1))}
    assert names == RUNTIME_DEPENDENCIES


def test_import_pulls_no_optional_or_heavy_modules():
    code = (
        "import sys, mitra; "
        "bad = [m for m in ('h2', 'brotli', 'zstandard', 'numpy', 'pandas', 'requests') "
        "if m in sys.modules]; print(bad)"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "[]"


def test_import_is_fast():
    best = float("inf")
    for _ in range(3):
        started = time.perf_counter()
        subprocess.run([sys.executable, "-c", "import mitra"], check=True)
        best = min(best, time.perf_counter() - started)
    assert best <= IMPORT_BUDGET_SECONDS, f"import mitra took {best:.2f}s"
