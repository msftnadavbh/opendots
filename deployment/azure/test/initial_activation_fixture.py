"""Execute the real recovery transaction against private files and mocked host commands only."""
import hashlib
import ast
import importlib.util
import json
import os
from pathlib import Path
import shutil
import shlex
import stat
import subprocess
import sys
import types

root = Path(sys.argv[1])
case = sys.argv[2]
mode = 'recovery'
if case.startswith(('check-initial:', 'check-caddy:')):
    mode, case = case.split(':', 1)
scenario = case
plan = json.load(sys.stdin)
source = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('recovery', source / 'initial-activation.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)
if mode != 'recovery':
    outer = shlex.split(plan['command'])
    assert outer[:4] == ['sudo', '-n', '/bin/bash', '-c'] and len(outer) == 5
    launch = shlex.split(outer[4].split('exec timeout --kill-after=10 180 /bin/bash -c ', 1)[1])
    assert len(launch) == 1
    python = shlex.split(launch[0])
    assert python[:3] == ['/usr/bin/python3', '-B', '-c'] and len(python) == 4
    tree = ast.parse(python[3])
    invocation = tree.body.pop()
    assert isinstance(invocation, ast.Expr) and isinstance(invocation.value, ast.Call)
    assert invocation.value.func.id == ('check_initial' if mode == 'check-initial' else 'check_caddy')
    recovery = types.ModuleType('actual_readonly_program')
    exec(compile(tree, 'actual-readonly-program', 'exec'), recovery.__dict__)
old, new = plan['oldUnit'].encode(), plan['newUnit'].encode()
intent = {key: value for key, value in plan.items() if key not in ('oldUnit', 'newUnit')}
base = root / 'etc/opendots/initial-activation-v1'
unit = root / 'etc/systemd/system/opendots.service'
data = root / 'srv/opendots'
audit = root / 'fixture-audit.jsonl'
cache = root / 'fixture-effective-unit'
for directory in ['etc/opendots', 'etc/systemd/system', 'usr/local/lib/opendots', 'srv/opendots/lost+found', 'run']:
    (root / directory).mkdir(parents=True, exist_ok=True, mode=0o700)
data.chmod(0o700)
unit.write_bytes(old)
unit.chmod(0o644)
cache.write_bytes(old)
for name in recovery.HELPERS:
    target = root / 'usr/local/lib/opendots' / name
    shutil.copyfile(source / name, target)
    target.chmod(0o755)
if mode != 'recovery':
    for path, content in [
        (unit.parent / 'srv-opendots.mount', plan['mount']),
        (root / 'etc/opendots/Caddyfile', plan['caddy']),
        (unit.parent / 'caddy.service.d/opendots.conf', plan['caddyService']),
    ]:
        path.parent.mkdir(mode=0o755, exist_ok=True)
        path.write_text(content)
        path.chmod(0o644)
    if case == 'mount-missing':
        (unit.parent / 'srv-opendots.mount').unlink()
    elif case == 'mount-drift':
        (unit.parent / 'srv-opendots.mount').write_text('foreign mount')
    elif case == 'caddy-mode':
        (root / 'etc/opendots/Caddyfile').chmod(0o600)
    elif case == 'caddy-bytes':
        (root / 'etc/opendots/Caddyfile').write_text('FAKE-PRIVATE-CADDY-CONTENT')
    elif case == 'caddy-dropin-bytes':
        (unit.parent / 'caddy.service.d/opendots.conf').write_text('foreign command')


def private_file(name, content):
    base.mkdir(mode=0o700, exist_ok=True)
    target = base / name
    target.write_bytes(content)
    target.chmod(0o600)


if case in ('runtime', 'database', 'other-data'):
    (data / {'runtime': 'runtime.env', 'database': 'opendots.sqlite', 'other-data': 'unrecognized'}[case]).write_text('FIXTURE-DATA')
elif case == 'lost-data':
    (data / 'lost+found/recovered').write_text('FIXTURE-DATA')
elif case == 'data-symlink':
    shutil.rmtree(data)
    data.symlink_to(root / 'etc/opendots')
elif case == 'lost-symlink':
    (data / 'lost+found').rmdir()
    (data / 'lost+found').symlink_to(root / 'etc/opendots')
elif case == 'pending-pull':
    (root / 'run/opendots-registry-fixture').mkdir(mode=0o700)
elif case == 'unit-mode':
    unit.chmod(0o600)
elif case == 'unit-symlink':
    unit.rename(root / 'untouched-unit')
    unit.symlink_to(root / 'untouched-unit')
elif case == 'unit-directory':
    unit.unlink()
    unit.mkdir()
elif case == 'unit-fifo':
    unit.unlink()
    os.mkfifo(unit, 0o644)
elif case == 'unit-hardlink':
    os.link(unit, root / 'untouched-unit')
elif case == 'unit-bytes':
    unit.write_bytes(old + b'# drift\n')
    cache.write_bytes(unit.read_bytes())
elif case == 'parent-writable':
    unit.parent.chmod(0o777)
elif case == 'private-writable':
    base.mkdir(mode=0o777)
    base.chmod(0o777)
elif case == 'helper-drift':
    (root / 'usr/local/lib/opendots/vm-host.sh').write_text('changed')
elif case.startswith('backup-'):
    private_file('old-unit.service', b'wrong' if case == 'backup-bytes' else old)
    if case == 'backup-mode':
        (base / 'old-unit.service').chmod(0o644)
    elif case == 'backup-symlink':
        (base / 'old-unit.service').unlink()
        (base / 'old-unit.service').symlink_to(unit)
elif case in ('wrong-intent', 'applied-old', 'prepared-new', 'applied-new'):
    private_file('old-unit.service', old)
    value = {**intent, 'operationId': '11111111-0000-0000-0000-000000000000'} if case == 'wrong-intent' else intent
    private_file('intent.json', recovery.encoded(value))
    if case in ('applied-old', 'applied-new'):
        private_file('applied.json', recovery.encoded({**intent, 'status': 'applied'}))
    if case in ('prepared-new', 'applied-new'):
        unit.write_bytes(new)
        if case == 'applied-new':
            cache.write_bytes(new)
elif case == 'new-without-intent':
    unit.write_bytes(new)


def observe(kind):
    global case
    case = kind
    if kind in ('runtime', 'database'):
        (data / ('runtime.env' if kind == 'runtime' else 'opendots.sqlite')).write_text('FIXTURE-DATA')


parts = scenario.split(':')
if parts[0] in ('prepared', 'swapped', 'applied'):
    private_file('old-unit.service', old)
    private_file('intent.json', recovery.encoded(intent))
    if parts[0] in ('swapped', 'applied'):
        unit.write_bytes(new)
    if parts[0] == 'applied':
        private_file('applied.json', recovery.encoded({**intent, 'status': 'applied'}))
        cache.write_bytes(new)
    if parts[1] == 'tombstone':
        private_file('ineligible.json', recovery.encoded({'version': 1, 'vmId': recovery.VM_ID, 'status': 'ineligible'}))
    else:
        observe(parts[1])
elif parts[0] == 'foreign-journal':
    private_file('intent.json', recovery.encoded({**intent, 'operationId': '11111111-0000-0000-0000-000000000000'}))
    observe('runtime')
elif parts[0] == 'foreign-conflict':
    private_file('intent.json', recovery.encoded(intent))
    private_file('conflict.json', recovery.encoded({**intent, 'operationId': '11111111-0000-0000-0000-000000000000', 'status': recovery.CONFLICT}))

original_records = {name: (base / name).read_bytes() for name in ('intent.json', 'applied.json') if (base / name).is_file()}
injected = False


def event(name):
    global injected
    with audit.open('a') as file:
        file.write(json.dumps(name) + '\n')
    if case == 'crash-' + name:
        os._exit(86)
    if parts[0] == 'during' and not injected and name == parts[1]:
        injected = True
        observe(parts[2])


def fdpath(fd):
    return Path(os.readlink('/proc/self/fd/' + str(fd)))


replaced = False
published = ''


def fixture_open(path, flags, file_mode=0o777, *, dir_fd=None):
    if path == '/':
        path = str(root)
    else:
        assert dir_fd is not None, 'No real absolute filesystem access is allowed'
    target = Path(path) if dir_fd is None else fdpath(dir_fd) / path
    assert target.is_relative_to(root)
    if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT):
        assert mode == 'recovery', 'Diagnostic attempted a filesystem write'
        assert target.is_relative_to(base) or target.parent == unit.parent
        event('write:' + str(target.relative_to(root)).split('/.')[0])
    if mode != 'recovery':
        assert target.name not in ('runtime.env', 'opendots.sqlite'), 'Diagnostic attempted to read private contents'
    if replaced and target == unit and not flags & os.O_WRONLY:
        event('unit-post-check')
    if target == base / 'applied.json' and target.exists():
        event('applied-post-check')
    return os.open(path, flags, file_mode, dir_fd=dir_fd)


def fixture_stat(fd):
    info = os.fstat(fd)
    fields = {name: getattr(info, name) for name in dir(info) if name.startswith('st_')}
    fields['st_uid'] = fields['st_gid'] = 0
    path = fdpath(fd)
    if (case == 'unit-owner' and path == unit) or (case == 'parent-owner' and path == unit.parent) or (case == 'data-owner' and path == data):
        fields['st_uid'] = 1001
    return types.SimpleNamespace(**fields)


def fixture_sync(fd):
    path = fdpath(fd)
    os.fsync(fd)
    if path == root / 'etc/opendots':
        event('private-directory-sync')
    elif path == base:
        event('private-records-sync')
        event(published + '-directory-sync')
    elif path == unit.parent:
        event('unit-directory-sync')
    elif path.name.startswith('.opendots-initial-'):
        event('unit-file-sync')
    elif path.name.startswith('.initial-'):
        kind = 'backup' if not (base / 'old-unit.service').exists() else 'intent' if not (base / 'intent.json').exists() else 'applied'
        event(kind + '-file-sync')
    elif path == unit:
        event('unit-file-resync')
    elif path.parent == base:
        event('record-file-resync')


def fixture_link(src, dst, **kwargs):
    global published
    os.link(src, dst, **kwargs)
    published = {'old-unit.service': 'backup', 'intent.json': 'intent', 'applied.json': 'applied', 'ineligible.json': 'ineligible', 'conflict.json': 'conflict'}[dst]
    event(published + '-publish')


def fixture_replace(src, dst, **kwargs):
    global replaced
    assert dst == 'opendots.service' and fdpath(kwargs['dst_dir_fd']) == unit.parent
    assert (base / 'old-unit.service').read_bytes() == old
    assert json.loads((base / 'intent.json').read_bytes()) == intent
    os.replace(src, dst, **kwargs)
    replaced = True
    event('unit-replace')


recovery.os = types.SimpleNamespace(**{name: getattr(os, name) for name in dir(os)})
recovery.os.open = fixture_open
recovery.os.fstat = fixture_stat
recovery.os.fsync = fixture_sync
recovery.os.link = fixture_link
recovery.os.replace = fixture_replace
recovery.os.geteuid = lambda: 0


def execution(path, argv):
    return '{ path=' + path + ' ; argv[]=' + argv + ' ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }'


unknown = []


def host(args, **options):
    assert options['check'] is False and options['timeout'] == 45
    assert not any('format' in part or 'mkfs' in part or part in ('start', 'enable', 'stop', 'restart') for part in args)
    if mode != 'recovery':
        assert not any(part in ('mount', 'prepare', 'repair', 'pull', 'configure', 'daemon-reload', 'reload') for part in args)
    event('command:' + ' '.join(args[:3]))
    result = ''
    failure = False
    if args == ['/usr/bin/python3', '/usr/local/lib/opendots/vm-disk.py', 'check']:
        value = {'operationId': plan['diskOperationId'], 'vmUniqueId': plan['binding']['vmUniqueId'], 'diskId': recovery.DISK_ID,
                 'diskUniqueId': plan['binding']['diskUniqueId'], 'fsUuid': plan['fsUuid']}
        if case in ('wrong-uuid', 'wrong-vm', 'wrong-disk', 'wrong-disk-id', 'wrong-format-op'):
            value[{'wrong-uuid': 'fsUuid', 'wrong-vm': 'vmUniqueId', 'wrong-disk': 'diskUniqueId', 'wrong-disk-id': 'diskId', 'wrong-format-op': 'operationId'}[case]] = 'foreign'
        result = json.dumps(value)
        failure = case == 'disk-error'
    elif args[:3] == ['/usr/bin/docker', 'container', 'ls']:
        assert args[3:] == ['--all', '--quiet', '--no-trunc']
        result = 'stopped-container\n' if case in ('container', 'stopped-container') else ''
        failure = case == 'container-error'
    elif args[:3] == ['/usr/bin/docker', 'image', 'ls']:
        assert args[3:] == ['--all', '--quiet', '--no-trunc']
        result = 'sha256:fixture\n' if case == 'image' else ''
        failure = case == 'image-error'
    elif args[:3] == ['/usr/bin/systemctl', 'show', 'opendots.service']:
        image = plan['newImage'] if cache.read_bytes() == new else plan['oldImage']
        value = {name: '0' for name in recovery.FIELDS}
        value.update(FragmentPath=recovery.UNIT, DropInPaths='', LoadState='loaded', ActiveState='inactive', SubState='dead',
                     UnitFileState='disabled', Job='0', InvocationID='', NeedDaemonReload='no' if unit.is_file() and unit.read_bytes() == cache.read_bytes() else 'yes',
                     RequiresMountsFor='/srv/opendots', BindsTo='srv-opendots.mount',
                     ExecStart=execution('/usr/local/lib/opendots/vm-host.sh', '/usr/local/lib/opendots/vm-host.sh run ' + image),
                     ExecStartPre=execution('/usr/bin/python3', '/usr/bin/python3 /usr/local/lib/opendots/vm-disk.py check'),
                     ExecStop=execution('/usr/bin/docker', '/usr/bin/docker stop --time 15 opendots-pilot'))
        patches = {'active': {'ActiveState': 'active'}, 'enabled': {'UnitFileState': 'enabled'}, 'job': {'Job': '13'},
                   'prior-activation': {'ExecMainStartTimestampMonotonic': '123'}, 'invocation': {'InvocationID': 'deadbeef'},
                   'drop-ins': {'DropInPaths': '/run/systemd/system/opendots.service.d/other.conf'}, 'fragment': {'FragmentPath': '/foreign/unit'},
                   'not-loaded': {'LoadState': 'not-found'}, 'effective-exec': {'ExecStart': value['ExecStart'].replace(' run ', ' other ')},
                   'effective-mount': {'RequiresMountsFor': '/foreign'}, 'reload-needed': {'NeedDaemonReload': 'yes'}}
        value.update(patches.get(case, {}))
        result = '\n'.join(key + '=' + value[key] for key in recovery.FIELDS) + '\n'
        failure = case == 'service-error'
    elif args[:2] == ['/usr/bin/systemctl', 'list-jobs']:
        result = '33 opendots.service start waiting\n' if case == 'activation-job' else ''
        failure = case == 'job-error'
    elif args[:3] == ['/usr/bin/systemctl', 'cat', 'opendots.service']:
        result = '# ' + recovery.UNIT + '\n' + unit.read_text()
        if case == 'cat-drift':
            result += '# /run/extra\nExecStart=foreign\n'
    elif args == ['/usr/bin/systemctl', 'daemon-reload']:
        failure = case == 'reload-error'
        if not failure:
            cache.write_bytes(unit.read_bytes())
        event('daemon-reload')
    elif args == ['/usr/bin/sudo', '-n', '-u', 'caddy', '--', '/usr/bin/test', '-r', '/etc/opendots/Caddyfile']:
        assert mode == 'check-caddy'
        failure = case == 'caddy-unreadable'
    elif args[:3] == ['/usr/bin/systemctl', 'show', 'caddy.service']:
        assert mode == 'check-caddy'
        value = dict(LoadState='loaded', ActiveState='active', SubState='running', User='caddy',
                     DropInPaths='/etc/systemd/system/caddy.service.d/opendots.conf', Job='0', NeedDaemonReload='no')
        changes = {'caddy-failed': {'ActiveState': 'failed'}, 'caddy-inactive': {'ActiveState': 'inactive'},
                   'caddy-user': {'User': 'root'}, 'caddy-extra-dropin': {'DropInPaths': value['DropInPaths'] + ' /foreign.conf'},
                   'caddy-job': {'Job': '123'}, 'caddy-reload': {'NeedDaemonReload': 'yes'}}
        value.update(changes.get(case, {}))
        result = '\n'.join(key + '=' + value[key] for key in value)
        failure = case == 'caddy-show-error'
    else:
        unknown.append(args)
        raise AssertionError('Unexpected host command')
    return subprocess.CompletedProcess(args, 1 if failure else 0, result, 'FIXTURE-PRIVATE-ERROR' if failure else '')


recovery.subprocess = types.SimpleNamespace(run=host)
before = unit.read_bytes() if unit.is_file() else None
if case.startswith('crash-'):
    child = os.fork()
    if child == 0:
        recovery.recover(plan)
        os._exit(0)
    _, status = os.waitpid(child, 0)
    assert os.waitstatus_to_exitcode(status) == 86, case + ' fault boundary was not reached'
    case = 'after-crash'

try:
    if mode == 'recovery':
        status = recovery.recover(plan)
    else:
        exec(compile(ast.Module(body=[invocation], type_ignores=[]), 'actual-readonly-invocation', 'exec'), recovery.__dict__)
        status = 'passed'
except recovery.Ineligible:
    assert mode != 'recovery'
    status = 'rejected'
except RuntimeError:
    status = 'rejected'
except OSError:
    status = 'rejected'
assert not unknown, unknown
if status == 'ineligible':
    # Deleting observations cannot manufacture eligibility once a tombstone exists.
    case = 'observation-removed'
    assert recovery.recover(plan) == 'ineligible'
if status == recovery.CONFLICT:
    facts = {name: (base / name).read_bytes() for name in ('intent.json', 'applied.json', 'old-unit.service', 'ineligible.json', 'conflict.json') if (base / name).is_file()}
    case = 'observation-removed'
    for name in ('runtime.env', 'opendots.sqlite'):
        (data / name).unlink(missing_ok=True)
    assert recovery.recover(plan) == recovery.CONFLICT
    assert facts == {name: (base / name).read_bytes() for name in facts}
    assert json.loads(facts['conflict.json']) == {**intent, 'status': recovery.CONFLICT}
assert all((base / name).read_bytes() == value for name, value in original_records.items())
events = [json.loads(line) for line in audit.read_text().splitlines()] if audit.exists() else []
print(json.dumps({
    'status': status, 'unitUnchanged': before == (unit.read_bytes() if unit.is_file() else None),
    'unitSha256': hashlib.sha256(unit.read_bytes()).hexdigest() if unit.is_file() else None,
    'backupSha256': hashlib.sha256((base / 'old-unit.service').read_bytes()).hexdigest() if (base / 'old-unit.service').is_file() else None,
    'intent': (base / 'intent.json').is_file(), 'applied': (base / 'applied.json').is_file(),
    'conflict': (base / 'conflict.json').is_file(),
    'ineligible': (base / 'ineligible.json').is_file(), 'unitWrites': events.count('unit-replace'), 'events': events,
}))
