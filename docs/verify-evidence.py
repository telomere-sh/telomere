"""Verify retained evidence using history-independent source snapshots."""
import pathlib
import runpy

runpy.run_path(str(pathlib.Path(__file__).with_name("verify-public-evidence.py")), run_name="__main__")
