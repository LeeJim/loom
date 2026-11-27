"""Manually run the approved README acceptance case."""
import fcntl
import os
import sqlite3

from run_docs import ROOT, run


if __name__ == "__main__":
    os.umask(0o027)
    with (ROOT / "data" / "worker.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with sqlite3.connect(ROOT / "data" / "workflow.sqlite") as database:
            run(database, 13)
