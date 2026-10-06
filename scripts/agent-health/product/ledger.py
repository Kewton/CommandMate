#!/usr/bin/env python3
"""The ledger of one product-path run (Issue #3312, stage 2 of the daily check).

<run base>/ledger/<run id>.json lists every resource a run makes, in two steps:
`planned` is written BEFORE the resource is made (with the names it can be
found by), `acquired` right after it exists (pid, its start time from
`ps -o lstart`, process group, socket path). The supervisor and the deadline
guard reclaim from it (scripts/agent-health/product/lib.sh). Every write goes
to a temp file in the same directory and is renamed over the ledger, so a
reader never sees half of it, however the writer died.

  ledger.py init     <file> <run id> <date> <run dir>
  ledger.py plan     <file> <resource id> <kind> <key=value>...
  ledger.py acquire  <file> <resource id> <key=value>...
  ledger.py mark     <file> <resource id> <state> [<note>]
  ledger.py set      <file> <key> <value>
  ledger.py append   <file> <key> <value>      (a list at the top level)
  ledger.py get      <file> <key>
  ledger.py list     <file>                    one TAB-separated line per resource:
                     id kind state pid lstart pgid sock db marker run_dir

Standard library only; python3 as on macOS. No third-party module.
"""

import json
import os
import sys
import tempfile

FIELDS = ("pid", "lstart", "pgid", "sock", "db", "marker", "run_dir", "uid")


def load(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def save(path, data):
    directory = os.path.dirname(os.path.abspath(path))
    fd, temp = tempfile.mkstemp(prefix=".ledger.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


def pairs(args):
    result = {}
    for arg in args:
        key, sep, value = arg.partition("=")
        if not sep or key not in FIELDS:
            raise SystemExit("ledger.py: bad field: %s" % arg)
        result[key] = value
    return result


def resource(data, rid):
    for item in data["resources"]:
        if item["id"] == rid:
            return item
    raise SystemExit("ledger.py: no resource %s" % rid)


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    command, path = argv[1], argv[2]
    rest = argv[3:]
    if command == "init":
        run_id, date, run_dir = rest
        save(path, {"runId": run_id, "date": date, "runDir": run_dir, "status": "open",
                    "resources": [], "reclaimedRuns": [], "unknownElsewhere": []})
        return 0
    data = load(path)
    if command == "plan":
        rid, kind = rest[0], rest[1]
        if any(item["id"] == rid for item in data["resources"]):
            raise SystemExit("ledger.py: resource %s is already in the ledger" % rid)
        item = {"id": rid, "kind": kind, "state": "planned", "note": ""}
        item.update(pairs(rest[2:]))
        data["resources"].append(item)
    elif command == "acquire":
        item = resource(data, rest[0])
        item.update(pairs(rest[1:]))
        item["state"] = "acquired"
    elif command == "mark":
        item = resource(data, rest[0])
        item["state"] = rest[1]
        item["note"] = rest[2] if len(rest) > 2 else ""
    elif command == "set":
        data[rest[0]] = rest[1]
    elif command == "append":
        data.setdefault(rest[0], []).append(rest[1])
    elif command == "get":
        value = data.get(rest[0], "")
        sys.stdout.write("%s\n" % (value if isinstance(value, str) else json.dumps(value)))
        return 0
    elif command == "list":
        for item in data["resources"]:
            sys.stdout.write("\t".join([item["id"], item["kind"], item["state"]] +
                                       [str(item.get(key, "")) or "-" for key in
                                        ("pid", "lstart", "pgid", "sock", "db", "marker", "run_dir")]) + "\n")
        return 0
    else:
        raise SystemExit("ledger.py: unknown command %s" % command)
    save(path, data)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
