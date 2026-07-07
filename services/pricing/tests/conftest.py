import os
import pytest


def _db_available() -> bool:
    db_url = os.environ.get("LC_DATABASE_URL", "")
    if not db_url:
        return False
    try:
        import psycopg
        conn = psycopg.connect(db_url, connect_timeout=3)
        conn.close()
        return True
    except Exception:
        return False


_DB_AVAILABLE = _db_available()

_DB_TEST_FILES = {"test_pricing.py"}


def pytest_collection_modifyitems(config, items):
    if _DB_AVAILABLE:
        return

    skip_db = pytest.mark.skip(reason="No DB available in CI — skipping DB integration tests")
    for item in items:
        if item.fspath.basename in _DB_TEST_FILES and item.cls is not None:
            src = item.fspath.read_text("utf-8")
            if "psycopg.connect" in src and hasattr(item.cls, "setup_method"):
                item.add_marker(skip_db)
