"""Plain-assert tests so the example needs no test framework."""

from cart import total


def test_total() -> None:
    items = [{"price": 2.5, "qty": 2}, {"price": 1.0, "qty": 3}]
    assert total(items) == 8.0, f"expected 8.0, got {total(items)}"


def test_empty() -> None:
    assert total([]) == 0.0


if __name__ == "__main__":
    failed = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as exc:
                failed += 1
                print(f"FAIL {name}: {exc}")
    raise SystemExit(1 if failed else 0)
