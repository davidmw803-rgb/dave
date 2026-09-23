from datetime import date

import pytest

from sloop.harness import regimes, synthetic
from sloop.store.duck import connect

AS_OF = date(2026, 9, 1)


@pytest.fixture(scope="session")
def world(tmp_path_factory):
    """One synthetic market for the whole session, copied per test that writes to it."""
    path = tmp_path_factory.mktemp("world") / "base.duckdb"
    con = connect(path)
    synthetic.build(con)
    regimes.compute(con)
    con.close()
    return path


@pytest.fixture
def con(world, tmp_path):
    import shutil
    p = tmp_path / "t.duckdb"
    shutil.copy(world, p)
    c = connect(p)
    yield c
    c.close()


@pytest.fixture
def mem():
    c = connect(":memory:")
    yield c
    c.close()
