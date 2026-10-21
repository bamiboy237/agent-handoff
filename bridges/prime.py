"""Bridge from agent-handoff (TypeScript) to the Prime Intellect sandbox SDK,
which is Python only. Usage: prime.py <operation>, with JSON arguments on stdin.
Prints one JSON object on stdout. Reads PRIME_API_KEY like the prime CLI."""

import json
import os
import sys
import tempfile

from prime_sandboxes import APIClient, CreateSandboxRequest, SandboxClient


def main() -> None:
    operation = sys.argv[1]
    args = json.load(sys.stdin)
    client = SandboxClient(APIClient())

    if operation == "create":
        sandbox = client.create(
            CreateSandboxRequest(
                name=args["name"],
                docker_image=args["image"],
                checkpoint_id=args.get("checkpointId"),
                cpu_cores=args["cpuCores"],
                memory_gb=args["memoryGb"],
                timeout_minutes=args["timeoutMinutes"],
                environment_vars=args["env"],
                labels=args["labels"],
            )
        )
        client.wait_for_creation(sandbox.id)
        result = {"id": sandbox.id}
    elif operation == "exec":
        response = client.execute_command(args["id"], args["command"], timeout=args["timeout"])
        result = {"exitCode": response.exit_code, "output": response.stdout + response.stderr}
    elif operation == "upload":
        with tempfile.NamedTemporaryFile("w", delete=False) as handle:
            handle.write(args["content"])
        try:
            client.upload_file(args["id"], args["path"], handle.name)
        finally:
            os.unlink(handle.name)
        result = {}
    elif operation == "background":
        job = client.start_background_job(args["id"], args["command"])
        result = {"jobId": job.job_id}
    elif operation == "checkpoint":
        checkpoint = client.wait_for_checkpoint(client.checkpoint(args["id"]).id, timeout_seconds=900)
        result = {"checkpointId": checkpoint.id, "state": checkpoint.state}
    elif operation == "ssh":
        session = client.create_ssh_session(args["id"], args["publicKey"], ttl_seconds=args["ttlSeconds"])
        result = {
            "user": session.session_id,
            "host": session.host,
            "port": session.port,
            "expiresAt": session.expires_at.isoformat(),
        }
    elif operation == "status":
        result = {"status": str(client.get(args["id"]).status)}
    elif operation == "delete":
        client.delete(args["id"])
        result = {}
    else:
        raise SystemExit(f"unknown operation {operation}")

    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
