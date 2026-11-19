"""Minimal stdio entry point; does not import the desktop UI or its dependencies."""
from native_bridge import main


if __name__ == "__main__":
    raise SystemExit(main())
