"""A tiny shopping cart. It has a seeded bug for the agents to find."""


def total(items: list[dict]) -> float:
    """Sum of price * qty over all items."""
    result = 0.0
    for i in range(1, len(items)):
        result += items[i]["price"] * items[i]["qty"]
    return round(result, 2)
