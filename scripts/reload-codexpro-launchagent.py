#!/usr/bin/env python3
"""Reload only the existing CodexPro LaunchAgent, with authoritative settle gates."""
import argparse
import datetime
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import time
import urllib.request

LABEL = 'com.will.codexpro.dev'
TIMEOUT = 30
INTERVAL = 0.1


def wait_until(probe, timeout=TIMEOUT, interval=INTERVAL):
    deadline = time.monotonic() + timeout
    while True:
        result = probe()
        if result:
            return result
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('CodexPro launchd settle/readiness gate timed out')
        time.sleep(min(interval, remaining))


def job_absent(result):
    if result.returncode == 0:
        return False
    if 'Could not find service "' + LABEL + '"' in result.stdout + result.stderr:
        return True
    raise RuntimeError('launchctl print failed without authoritative service absence')


def reload_service(command, target, plist):
    initial = command(['launchctl', 'print', target])
    if not job_absent(initial):
        command(['launchctl', 'bootout', target], checked=True)
    wait_until(lambda: job_absent(command(['launchctl', 'print', target])))
    command(['launchctl', 'bootstrap', target.rsplit('/', 1)[0], str(plist)], checked=True)
    def running():
        state = command(['launchctl', 'print', target])
        if state.returncode:
            return False
        match = re.search(r'^\s*pid = (\d+)$', state.stdout, re.M)
        return int(match.group(1)) if match and re.search(r'^\s*state = running$', state.stdout, re.M) else False
    return wait_until(running)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', choices=['ahr', 'orca'], required=True)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    args = parser.parse_args()
    args.evidence_dir.mkdir(parents=True, exist_ok=False)
    record = {'backend': args.backend, 'events': [], 'result': 'FAIL'}
    def save():
        (args.evidence_dir / 'reload.json').write_text(json.dumps(record, indent=2) + '\n')
    def command(argv, checked=False):
        started = datetime.datetime.now().astimezone().isoformat()
        result = subprocess.run(argv, capture_output=True, text=True, timeout=10)
        record['events'].append({'started': started, 'finished': datetime.datetime.now().astimezone().isoformat(),
                                 'argv': argv, 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
        save()
        if checked and result.returncode:
            raise RuntimeError(f'{argv[0:2]} failed ({result.returncode}): {result.stderr}')
        return result
    plist = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    target = f'gui/{os.getuid()}/{LABEL}'
    try:
        original = plist.read_bytes()
        data = plistlib.loads(original)
        if data.get('Label') != LABEL:
            raise RuntimeError('Unexpected LaunchAgent label')
        argv = data['ProgramArguments']
        if argv[0] != '/opt/homebrew/bin/node' or argv[1] != '/Users/will/.local/opt/codexpro-orca-371bc38/scripts/codexpro.mjs':
            raise RuntimeError('Unexpected production deployment entrypoint')
        if data.get('WorkingDirectory') != '/Users/will/will-liang329/agent-handoff-runner':
            raise RuntimeError('Unexpected production workspace')
        record['previous_backend'] = data.get('EnvironmentVariables', {}).get('CODEXPRO_EXECUTION_BACKEND')
        (args.evidence_dir / 'before.plist').write_bytes(original)
        data.setdefault('EnvironmentVariables', {})['CODEXPRO_EXECUTION_BACKEND'] = args.backend
        temporary = plist.with_suffix('.reload.tmp')
        temporary.write_bytes(plistlib.dumps(data))
        os.chmod(temporary, plist.stat().st_mode & 0o777)
        command(['plutil', '-lint', str(temporary)], checked=True)
        os.replace(temporary, plist)
        (args.evidence_dir / 'after.plist').write_bytes(plist.read_bytes())
        pid = reload_service(command, target, plist)
        def healthy():
            try:
                with urllib.request.urlopen('http://127.0.0.1:8787/healthz', timeout=2) as response:
                    body = json.load(response)
                    return body if response.status == 200 and body.get('ok') is True else False
            except (OSError, ValueError):
                return False
        health = wait_until(healthy)
        listener = command(['lsof', '-nP', '-iTCP:8787', '-sTCP:LISTEN'], checked=True)
        rows = listener.stdout.strip().splitlines()[1:]
        if len(rows) != 1:
            raise RuntimeError('Expected exactly one CodexPro listener')
        listener_pid = int(rows[0].split()[1])
        parent = command(['ps', '-p', str(listener_pid), '-o', 'ppid='], checked=True)
        if int(parent.stdout.strip()) != pid:
            raise RuntimeError('Listener does not belong to the new launchd service')
        command(['ps', '-p', f'{pid},{listener_pid}', '-o', 'pid,ppid,lstart,command'], checked=True)
        record.update(result='PASS', service_pid=pid, listener_pid=listener_pid, health=health)
        print(json.dumps({k: v for k, v in record.items() if k != 'events'}))
    except Exception as error:
        record['error'] = str(error)
        # Record diagnostics only; never hard-bootstrap past a failed absence gate.
        try:
            command(['launchctl', 'print', target])
        except Exception:
            pass
        raise
    finally:
        save()


if __name__ == '__main__':
    main()
