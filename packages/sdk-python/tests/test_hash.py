from __future__ import annotations

import subprocess
import sys
import time

import agentspace
from agentspace._client import Client, Config
from agentspace._hash import hash_arguments


def test_same_arguments_same_hash_whatever_the_form() -> None:
    a = hash_arguments({"path": "cart.py", "lines": [1, 2]})
    assert a is not None and len(a) == 16 and all(c in "0123456789abcdef" for c in a)
    assert hash_arguments({"lines": [1, 2], "path": "cart.py"}) == a  # key order
    assert hash_arguments('{"lines": [1, 2], "path": "cart.py"}') == a  # JSON in a string
    assert hash_arguments({"path": "cart.py", "lines": [2, 1]}) != a
    assert hash_arguments("cart.py") == hash_arguments("cart.py")
    assert hash_arguments("{not json") == hash_arguments("{not json")
    assert hash_arguments(None) is not None  # a call with no arguments can still repeat


def test_the_key_is_random_per_process() -> None:
    code = "from agentspace._hash import hash_arguments; print(hash_arguments({'user_id': 18291}))"

    def run() -> str:
        return subprocess.run([sys.executable, "-c", code], capture_output=True, text=True).stdout

    first, second = run().strip(), run().strip()
    assert len(first) == 16 and first != second
    assert hash_arguments({"user_id": 18291}) not in (first, second)


def test_never_raises_and_stays_bounded() -> None:
    class Weird:
        def __repr__(self) -> str:
            raise RuntimeError("no")

    # default=str falls back to repr, which raises: no hash, no exception.
    assert hash_arguments({"x": Weird()}) is None
    huge = "x" * 5_000_000
    started = time.perf_counter()
    assert hash_arguments(huge) == hash_arguments(huge + "different after the cap")
    assert time.perf_counter() - started < 0.1


def test_client_hash_can_be_turned_off() -> None:
    url = "http://127.0.0.1:9"
    on = Client(Config(url=url, workspace="w", enabled=False))
    off = Client(Config(url=url, workspace="w", enabled=False, hash_arguments=False))
    assert on.args_hash({"a": 1}) == hash_arguments({"a": 1})
    assert off.args_hash({"a": 1}) is None
    assert agentspace.hash_arguments is hash_arguments
