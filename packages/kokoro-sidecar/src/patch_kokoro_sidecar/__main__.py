"""Entry point so `python -m patch_kokoro_sidecar` works."""

from .sidecar import main


def cli() -> None:
    main()


if __name__ == "__main__":
    cli()
