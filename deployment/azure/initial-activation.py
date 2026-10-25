"""Version 1: recover only the never-activated pilot unit, without starting it."""
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import uuid

OLD_IMAGE = 'odpilot7unu3az5tgmza.azurecr.io/opendots@sha256:ea4668cc47fd6e22a8cbd5a80ca42742aa8890b4a44fac3db304562a0541f978'
OLD_SHA = '2813973ad9b447ebbd89e31354a7a85053eacf94808c83e84f648e98e89a73d3'
VM_ID = '/subscriptions/68eab0d1-ab81-4851-b2dd-173dede87582/resourceGroups/rg-opendots-pilot/providers/Microsoft.Compute/virtualMachines/vm-opendots-pilot'
DISK_ID = VM_ID.split('/providers/')[0] + '/providers/Microsoft.Compute/disks/disk-opendots-pilot-data'
UNIT = '/etc/systemd/system/opendots.service'
BASE = '/etc/opendots/initial-activation-v1'
CONFLICT = 'post-intent-conflict'
HELPERS = {
    'vm-host.sh': 'f872b3d1b67dc7f54f4386c5dc458d69e3123619c2e90ced7a64ee13835c8784',
    'vm-disk.py': 'df76fc6d40075d3253b5844a53234c87639a785d929329949a638baae415f778',
    'vm-bootstrap.sh': '6add0dfbf2d8207cbc5710e4f004bce15bf54a1e127e675977552f111f1aafcf',
}
FIELDS = ['FragmentPath', 'DropInPaths', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'Job',
          'MainPID', 'ExecMainPID', 'ExecMainStartTimestampMonotonic', 'ActiveEnterTimestampMonotonic',
          'InactiveExitTimestampMonotonic', 'InvocationID', 'NRestarts', 'NeedDaemonReload',
          'ExecStart', 'ExecStartPre', 'ExecStop', 'RequiresMountsFor', 'BindsTo']


class Ineligible(Exception):
    pass


def demand(condition):
    if not condition:
        raise RuntimeError('Initial recovery safety gate failed.')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def directory(path, app=False):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open('/', flags)
    try:
        for part in [''] + path.split('/')[1:]:
            if part:
                next_fd = os.open(part, flags, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            info = os.fstat(fd)
            final_app = app and part == 'opendots'
            demand(stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o022 and
                   info.st_uid in ((0, 1000) if final_app else (0,)))
        return fd
    except Exception:
        os.close(fd)
        raise


def read(fd, name, mode, optional=False, durable=False):
    try:
        leaf = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        if optional:
            return None
        raise
    with os.fdopen(leaf, 'rb') as file:
        info = os.fstat(file.fileno())
        # Private exclusive publication may retain its temporary hard link after a crash.
        demand(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and
               (mode == 0o600 or info.st_nlink == 1) and stat.S_IMODE(info.st_mode) == mode and info.st_size <= 65536)
        data = file.read(65537)
        if durable:
            os.fsync(file.fileno())
        return data


def publish(fd, name, data):
    previous = read(fd, name, 0o600, optional=True, durable=True)
    if previous is not None:
        demand(previous == data)
        os.fsync(fd)  # A crash may have published the link but not synced its directory.
        return
    temporary = '.initial-' + str(uuid.uuid4())
    leaf = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        with os.fdopen(leaf, 'wb') as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
        os.unlink(temporary, dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(temporary, dir_fd=fd)
        except FileNotFoundError:
            pass
    demand(read(fd, name, 0o600) == data)


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def run(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=45, check=False,
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'})
    demand(result.returncode == 0 and len(result.stdout) <= 65536)
    return result.stdout


def properties():
    text = run(['/usr/bin/systemctl', 'show', 'opendots.service', '--no-pager', '--property=' + ','.join(FIELDS)])
    lines = [line.split('=', 1) for line in text.splitlines()]
    demand(all(len(line) == 2 for line in lines) and len(lines) == len(FIELDS))
    value = dict(lines)
    demand(set(value) == set(FIELDS))
    return value


def inactive(value):
    if (value['ActiveState'] != 'inactive' or value['SubState'] != 'dead' or
        value['UnitFileState'] != 'disabled' or value['Job'] not in ('', '0') or value['InvocationID'] or
        any(value[key] != '0' for key in ['MainPID', 'ExecMainPID', 'ExecMainStartTimestampMonotonic',
            'ActiveEnterTimestampMonotonic', 'InactiveExitTimestampMonotonic', 'NRestarts'])):
        raise Ineligible()
    jobs = run(['/usr/bin/systemctl', 'list-jobs', '--no-legend', '--no-pager', '--plain'])
    if any('opendots.service' in line.split() for line in jobs.splitlines()):
        raise Ineligible()


def effective(value, unit, image):
    demand(value['FragmentPath'] == UNIT and value['DropInPaths'] == '' and value['LoadState'] == 'loaded' and
           value['NeedDaemonReload'] == 'no' and value['RequiresMountsFor'] == '/srv/opendots' and
           value['BindsTo'] == 'srv-opendots.mount')
    demand(run(['/usr/bin/systemctl', 'cat', 'opendots.service', '--no-pager']).strip() ==
           ('# ' + UNIT + '\n' + unit.decode()).strip())
    for key, path, argv in [
        ('ExecStart', '/usr/local/lib/opendots/vm-host.sh', '/usr/local/lib/opendots/vm-host.sh run ' + image),
        ('ExecStartPre', '/usr/bin/python3', '/usr/bin/python3 /usr/local/lib/opendots/vm-disk.py check'),
        ('ExecStop', '/usr/bin/docker', '/usr/bin/docker stop --time 15 opendots-pilot'),
    ]:
        text = value[key]
        demand(text.startswith('{ ') and text.endswith(' }') and text.count('{') == 1)
        parts = [part.split('=', 1) for part in text[2:-2].split(' ; ')]
        demand(all(len(part) == 2 for part in parts))
        fields = dict(parts)
        demand(len(parts) == len(fields) and set(fields) == {'path', 'argv[]', 'ignore_errors', 'start_time',
               'stop_time', 'pid', 'code', 'status'} and fields['path'] == path and fields['argv[]'] == argv and
               fields['ignore_errors'] == 'no' and fields['pid'] == '0' and fields['code'] == '(null)' and
               fields['status'] in ('0', '0/0') and fields['start_time'] == '[n/a]' and fields['stop_time'] == '[n/a]')


def pristine(plan):
    helpers = directory('/usr/local/lib/opendots')
    try:
        for name, expected in HELPERS.items():
            demand(digest(read(helpers, name, 0o755)) == expected)
    finally:
        os.close(helpers)
    disk = json.loads(run(['/usr/bin/python3', '/usr/local/lib/opendots/vm-disk.py', 'check']))
    demand(disk == {'operationId': plan['diskOperationId'], 'vmUniqueId': plan['binding']['vmUniqueId'],
                    'diskId': DISK_ID, 'diskUniqueId': plan['binding']['diskUniqueId'], 'fsUuid': plan['fsUuid']})
    pending = directory('/run')
    try:
        demand(not any(name.startswith('opendots-registry-') for name in os.listdir(pending)))
    finally:
        os.close(pending)
    # A pristine one-off host cannot hide app images/containers among unidentifiable leftovers.
    if run(['/usr/bin/docker', 'container', 'ls', '--all', '--quiet', '--no-trunc']).strip():
        raise Ineligible()
    if run(['/usr/bin/docker', 'image', 'ls', '--all', '--quiet', '--no-trunc']).strip():
        raise Ineligible()
    data = directory('/srv/opendots', app=True)
    try:
        demand(stat.S_IMODE(os.fstat(data).st_mode) == 0o700)
        names = os.listdir(data)
        if any(name != 'lost+found' for name in names):
            raise Ineligible()
        if names:
            lost = os.open('lost+found', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=data)
            try:
                info = os.fstat(lost)
                demand(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700)
                if os.listdir(lost):
                    raise Ineligible()
            finally:
                os.close(lost)
    finally:
        os.close(data)
    value = properties()
    inactive(value)
    return value


def replace_unit(fd, old, new):
    demand(read(fd, 'opendots.service', 0o644) == old)
    temporary = '.opendots-initial-' + str(uuid.uuid4())
    leaf = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        with os.fdopen(leaf, 'wb') as file:
            os.fchmod(file.fileno(), 0o644)
            file.write(new)
            file.flush()
            os.fsync(file.fileno())
        demand(read(fd, 'opendots.service', 0o644) == old)
        os.replace(temporary, 'opendots.service', src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(temporary, dir_fd=fd)
        except FileNotFoundError:
            pass
    demand(read(fd, 'opendots.service', 0o644) == new)


def recover(plan):
    demand(os.geteuid() == 0 and plan['version'] == 1 and str(uuid.UUID(plan['operationId'])) == plan['operationId'])
    demand(plan['binding']['vmId'] == VM_ID and plan['binding']['diskId'] == DISK_ID)
    demand(plan['oldImage'] == OLD_IMAGE and plan['oldUnitSha256'] == OLD_SHA and
           re.fullmatch(r'odpilot7unu3az5tgmza\.azurecr\.io/opendots@sha256:[a-f0-9]{64}', plan['newImage']) and plan['newImage'] != OLD_IMAGE)
    old, new = plan['oldUnit'].encode(), plan['newUnit'].encode()
    demand(digest(old) == OLD_SHA and old.count(OLD_IMAGE.encode()) == 1 and
           new == old.replace(OLD_IMAGE.encode(), plan['newImage'].encode()) and digest(new) == plan['newUnitSha256'])
    intent = {key: value for key, value in plan.items() if key not in ('oldUnit', 'newUnit')}
    parent = directory('/etc/opendots')
    try:
        try:
            os.mkdir('initial-activation-v1', mode=0o700, dir_fd=parent)
        except FileExistsError:
            pass
        os.fsync(parent)
    finally:
        os.close(parent)
    private, systemd = directory(BASE), directory('/etc/systemd/system')
    try:
        demand(stat.S_IMODE(os.fstat(private).st_mode) == 0o700)
        saved = read(private, 'intent.json', 0o600, optional=True, durable=True)
        applied = read(private, 'applied.json', 0o600, optional=True, durable=True)
        conflict = read(private, 'conflict.json', 0o600, optional=True, durable=True)
        tombstone = read(private, 'ineligible.json', 0o600, optional=True, durable=True)
        if saved is not None:
            demand(saved == encoded(intent))
        if applied is not None:
            demand(applied == encoded({**intent, 'status': 'applied'}))
        blocked = encoded({**intent, 'status': CONFLICT})
        if conflict is not None:
            demand(conflict == blocked)
            os.fsync(private)
            return CONFLICT
        transaction = saved is not None or applied is not None
        if tombstone is not None and transaction:
            publish(private, 'conflict.json', blocked)
            return CONFLICT
        unit = read(systemd, 'opendots.service', 0o644)
        if (applied is not None and (saved is None or unit != new)) or (saved is None and unit != old) or unit not in (old, new):
            publish(private, 'conflict.json', blocked)
            return CONFLICT
        if tombstone is not None:
            demand(tombstone == encoded({'version': 1, 'vmId': VM_ID, 'status': 'ineligible'}))
            os.fsync(private)
            return 'ineligible'
        try:
            # Journal phase is known before any activation/data eligibility observation.
            value = pristine(plan)
            if saved is not None:
                demand(read(private, 'old-unit.service', 0o600, durable=True) == old)
                os.fsync(private)
            if applied is not None:
                demand(read(systemd, 'opendots.service', 0o644, durable=True) == new)
                os.fsync(systemd)
                effective(value, new, plan['newImage'])
                return 'applied'
            if unit == old:
                effective(value, old, OLD_IMAGE)
                publish(private, 'old-unit.service', old)
                transaction = True
                publish(private, 'intent.json', encoded(intent))
                effective(pristine(plan), old, OLD_IMAGE)
                replace_unit(systemd, old, new)
            else:
                demand(saved is not None)  # A new unit without this durable intent is never adopted.
            demand(read(systemd, 'opendots.service', 0o644, durable=True) == new)
            os.fsync(systemd)
            run(['/usr/bin/systemctl', 'daemon-reload'])
            effective(pristine(plan), new, plan['newImage'])
            publish(private, 'applied.json', encoded({**intent, 'status': 'applied'}))
            effective(pristine(plan), new, plan['newImage'])
            return 'applied'
        except Ineligible:
            if transaction:
                publish(private, 'conflict.json', blocked)
                return CONFLICT
            publish(private, 'ineligible.json', encoded({'version': 1, 'vmId': VM_ID, 'status': 'ineligible'}))
            return 'ineligible'
    finally:
        os.close(private)
        os.close(systemd)


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(65537)
        demand(len(raw) <= 65536)
        plan = json.loads(raw)
        status = recover(plan)
        print(json.dumps({'operationId': plan['operationId'], 'status': status,
                          'oldUnitSha256': plan['oldUnitSha256'], 'newUnitSha256': plan['newUnitSha256']}))
    except Exception:
        # The managed wrapper supplies a fixed failure category, never a traceback or raw tool output.
        sys.exit(1)
