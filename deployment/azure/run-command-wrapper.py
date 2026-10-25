"""Inline managed Run Command wrapper. Only its fixed receipt reaches the agent."""
import base64
import hashlib
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import time

# Named Linux protected parameters arrive in the environment, never argv.
protected_input = os.environ.pop('OPENDOTS_PROTECTED_INPUT', None)
INPUT_LIMIT = 65536
OUTPUT_LIMIT = 2048


def demand(condition):
    if not condition:
        raise ValueError('invalid')


def child(command, data, deadline, capture):
    if time.monotonic() >= deadline:
        return 124, 'deadline', b''
    process = subprocess.Popen(
        command if isinstance(command, list) else ['/bin/bash', '-c', command], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, start_new_session=True,
        env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'},
    )
    output = bytearray()
    try:
        with selectors.DefaultSelector() as streams:
            if data:
                os.set_blocking(process.stdin.fileno(), False)
                streams.register(process.stdin, selectors.EVENT_WRITE)
            else:
                process.stdin.close()
            if capture:
                os.set_blocking(process.stdout.fileno(), False)
                streams.register(process.stdout, selectors.EVENT_READ)
            position = 0
            while streams.get_map() or process.poll() is None:
                if time.monotonic() >= deadline:
                    return 124, 'deadline', b''
                for key, _ in streams.select(min(0.1, max(0, deadline - time.monotonic()))):
                    if key.fileobj is process.stdin:
                        try:
                            position += os.write(process.stdin.fileno(), data[position:position + 4096])
                        except BrokenPipeError:
                            position = len(data)
                        if position == len(data):
                            streams.unregister(process.stdin)
                            process.stdin.close()
                    else:
                        chunk = os.read(process.stdout.fileno(), OUTPUT_LIMIT + 1)
                        output.extend(chunk)
                        if len(output) > OUTPUT_LIMIT:
                            return 65, 'invalid-output', b''
                        if not chunk:
                            streams.unregister(process.stdout)
                            process.stdout.close()
            code = process.wait()
            code = code if code >= 0 else 128 - code
            return code, 'ok' if code == 0 else 'command-failed', bytes(output)
    finally:
        # Also kill descendants that inherited pipes or outlived the shell.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=10)
        for stream in (process.stdin, process.stdout):
            if stream:
                stream.close()


def result(spec, raw):
    schema = spec['schema']
    if schema == 'empty':
        return ''
    text = raw.decode('utf8').strip()
    if schema == 'status':
        demand(text == 'active')
    elif schema == 'image':
        demand(text in ('true', 'false'))
    elif schema == 'disk':
        value = json.loads(text)
        demand(set(value) == {'operationId', 'vmUniqueId', 'diskId', 'diskUniqueId', 'fsUuid'})
        demand(all(value[key] == expected for key, expected in spec['disk'].items() if key != 'fsUuid'))
        demand(re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', value['fsUuid']))
        demand(not spec['disk']['fsUuid'] or value['fsUuid'] == spec['disk']['fsUuid'])
        return value
    elif schema == 'recovery':
        value = json.loads(text)
        demand(set(value) == {'operationId', 'status', 'oldUnitSha256', 'newUnitSha256'})
        demand(value['status'] in ('applied', 'ineligible', 'post-intent-conflict'))
        demand(all(value[key] == expected for key, expected in spec['recovery'].items()))
        return value
    else:
        raise ValueError('invalid')
    return text


def main(spec):
    global protected_input
    code, category, value = 64, 'invalid-input', ''
    deadline = time.monotonic() + spec['seconds']
    try:
        if spec['hasInput']:
            demand(isinstance(protected_input, str) and len(protected_input) <= 87384)
            data = base64.b64decode(protected_input, validate=True)
            demand(len(data) <= INPUT_LIMIT and base64.b64encode(data).decode() == protected_input)
        else:
            demand(protected_input is None)
            data = b''
        protected_input = None
        if spec['schema'] == 'canary':
            demand(hashlib.sha256(data).hexdigest() == spec['canarySha256'])
            # Check the direct child BEFORE sudo can hide a leaked environment variable.
            check = "import os,sys,hashlib; d=sys.stdin.buffer.read(); sys.exit(0 if 'OPENDOTS_PROTECTED_INPUT' not in os.environ and hashlib.sha256(d).hexdigest()=='" + spec['canarySha256'] + "' else 1)"
            code, category, _ = child(['/usr/bin/python3', '-c', check], data, deadline, False)
            if code == 0:
                code, category, _ = child(spec['command'], b'', deadline, False)
            value = 'canary-ok' if code == 0 else ''
        else:
            code, category, raw = child(spec['command'], data, deadline, spec['schema'] != 'empty')
            if code == 0:
                try:
                    value = result(spec, raw)
                except Exception:
                    code, category = 65, 'invalid-output'
    except Exception:
        code, category, value = 64, 'invalid-input', ''
    protected_input = None
    print(json.dumps({'version': 1, 'operationId': spec['operationId'], 'exitCode': code,
                      'category': category, 'result': value}, separators=(',', ':')))
    sys.exit(code)
