import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from store import Store  # noqa: E402


def test_workspace_mapping_roundtrip(tmp_path):
    store = Store(str(tmp_path / "t.sqlite3"))
    assert store.get_workspace("C1") is None
    store.set_workspace("C1", "w1")
    store.set_workspace("C1", "w2")
    assert store.get_workspace("C1") == "w2"
    assert store.get_workspace("C2") is None


def test_conversation_expires(tmp_path):
    store = Store(str(tmp_path / "t.sqlite3"))
    store.set_conversation("C1:1", "conv")
    assert store.get_conversation("C1:1") == "conv"
    assert store.get_conversation("C1:1", max_age_sec=-1) is None
