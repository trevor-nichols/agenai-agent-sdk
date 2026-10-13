"""Synthetic wheel console script: credentialless ACP permission continuation."""
import atexit
import json
import os
import signal
import sys


def main():
    report_path, mode, *args = sys.argv[1:]
    assert mode == "permission"
    report = {"pid": os.getpid(), "mode": mode, "args": args, "env": dict(os.environ),
              "cwd": os.getcwd(), "methods": [], "permissionResponses": [],
              "emitted": 0, "promptReady": False, "exited": False}
    prompt_id = None

    def persist():
        with open(report_path + ".tmp", "w", encoding="utf-8") as destination:
            json.dump(report, destination)
        os.replace(report_path + ".tmp", report_path)

    def send(**message):
        print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)

    def update(**value):
        report["emitted"] += 1
        send(method="session/update", params={"sessionId": "retained-native", "update": value})

    def exited():
        report["exited"] = True
        persist()

    atexit.register(exited)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    persist()
    for line in sys.stdin:
        assert len(line.encode()) <= 16_384
        frame = json.loads(line)
        if "method" in frame:
            method = frame["method"]
            report["methods"].append(method)
            assert len(report["methods"]) <= 3
            if method == "initialize":
                assert frame["params"]["protocolVersion"] == 1
                send(id=frame["id"], result={"protocolVersion": 1, "agentCapabilities": {}, "authMethods": [],
                                            "agentInfo": {"name": "retained-packed-fixture", "version": "1.2.3"}})
            elif method == "session/new":
                assert frame["params"]["cwd"] == report["cwd"]
                send(id=frame["id"], result={"sessionId": "retained-native"})
            else:
                assert method == "session/prompt" and prompt_id is None
                assert frame["params"] == {"sessionId": "retained-native", "prompt": [{"type": "text", "text": "Exercise retained offline ACP"}]}
                prompt_id = frame["id"]
                update(sessionUpdate="tool_call", toolCallId="permission-1", title="Read fixture", status="in_progress")
                send(id="permission-1", method="session/request_permission", params={"sessionId": "retained-native",
                     "toolCall": {"toolCallId": "permission-1", "title": "Read fixture", "status": "in_progress"},
                     "options": [{"optionId": "allow", "name": "Allow once", "kind": "allow_once"},
                                 {"optionId": "deny", "name": "Deny once", "kind": "reject_once"}]})
                report["promptReady"] = True
        else:
            assert prompt_id is not None and not report["permissionResponses"]
            assert frame["id"] == "permission-1"
            assert frame["result"] == {"outcome": {"outcome": "selected", "optionId": "allow"}}
            report["permissionResponses"].append({"id": frame["id"], "result": frame["result"]})
            update(sessionUpdate="tool_call_update", toolCallId="permission-1", status="completed")
            update(sessionUpdate="agent_message_chunk", content={"type": "text", "text": "Retained offline result"})
            send(id=prompt_id, result={"stopReason": "end_turn"})
        persist()
