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


def pytest_collection_modifyitems(config, items):
    if _DB_AVAILABLE:
        return  # DB is up — run everything

    skip_db = pytest.mark.skip(reason="No DB available in CI — skipping DB integration tests")
    for item in items:
        # Skip any test whose setup_method or fixture opens a psycopg connection
        if "setup_method" in dir(item.cls or object):
            src = item.fspath.read_text()
            if "psycopg.connect" in src:
                item.add_marker(skip_db)
