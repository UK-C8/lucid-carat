import os
import pytest

def pytest_collection_modifyitems(config, items):
    """Skip any test that requires a live DB when LC_DATABASE_URL is not set."""
    db_url = os.environ.get("LC_DATABASE_URL", "")
    if db_url:
        return  # DB available — run everything

    skip_db = pytest.mark.skip(reason="LC_DATABASE_URL not set — skipping DB tests in CI")
    db_test_classes = {
        "TestWriterForecast",
        "TestWriterAdjustment",
        "TestDBConstraints",
    }
    for item in items:
        if item.cls and item.cls.__name__ in db_test_classes:
            item.add_marker(skip_db)
