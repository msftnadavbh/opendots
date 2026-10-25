#!/usr/bin/python3
"""Pilot-only NVMe gate. No device override, force-format, or unmount operation."""
import json
import os
import re
import stat
import subprocess
import sys
import uuid
import tempfile

LUN = '/dev/disk/azure/data/by-lun/0'
MOUNT = '/srv/opendots'
BASE = '/etc/opendots'
DISK_ID = '/subscriptions/68eab0d1-ab81-4851-b2dd-173dede87582/resourceGroups/rg-opendots-pilot/providers/Microsoft.Compute/disks/disk-opendots-pilot-data'
SIZE = 32 * 1024 ** 3
IDENTITY = ('operationId', 'vmUniqueId', 'diskId', 'diskUniqueId')


def demand(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(args, missing=False):
    result = subprocess.run(args, capture_output=True, text=True, timeout=120, check=False)
    if missing and result.returncode == 1:
        return ''
    demand(result.returncode == 0, 'A required disk inspection/operation failed.')
    return result.stdout


def read_state(name):
    path = BASE + '/' + name + '.json'
    if not os.path.lexists(path):
        return None
    info = os.lstat(path)
    demand(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600,
           'Disk state must be a root-owned private regular file.')
    with open(path, encoding='utf8') as file:
        return json.load(file)


def write_state(name, value):
    os.makedirs(BASE, mode=0o755, exist_ok=True)
    path = BASE + '/' + name + '.json'
    fd, temporary = tempfile.mkstemp(dir=BASE, prefix='.' + name + '-')
    try:
        with os.fdopen(fd, 'w', encoding='utf8') as file:
            json.dump(value, file, sort_keys=True)
            file.flush()
            os.fsync(file.fileno())
        os.link(temporary, path)  # Atomic, exclusive publication; never overwrite an existing binding.
    finally:
        os.unlink(temporary)
    directory = os.open(BASE, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def valid_plan(plan):
    demand(plan.get('diskId', '').lower() == DISK_ID.lower(), 'Foreign disk ID.')
    for key in ('operationId', 'vmUniqueId', 'diskUniqueId'):
        demand(isinstance(plan.get(key), str) and re.fullmatch(r'[A-Za-z0-9-]{1,128}', plan[key]), 'Invalid immutable disk/VM identity.')
    demand(type(plan.get('allowFormat')) is bool, 'Missing explicit format decision.')
    if plan.get('fsUuid'):
        demand(str(uuid.UUID(plan['fsUuid'])) == plan['fsUuid'], 'Invalid filesystem UUID.')


def flatten(nodes, parent=None):
    result = []
    for node in nodes:
        item = dict(node)
        item['parent'] = parent
        result.append(item)
        result.extend(flatten(node.get('children', []), node['name']))
    return result


def probe():
    demand(run(['dpkg-query', '-W', '-f=${Status}', 'azure-vm-utils']).strip() == 'install ok installed', 'azure-vm-utils is required.')
    rules = run(['dpkg-query', '-L', 'azure-vm-utils']).splitlines()
    demand(any(path.endswith('/udev/rules.d/80-azure-disk.rules') and os.path.isfile(path) for path in rules), 'Packaged Azure disk udev rules are required.')
    run(['udevadm', 'settle', '--timeout=30'])
    demand(os.path.islink(LUN), 'Missing Azure data LUN0 symlink; never guess an NVMe number.')
    device = os.path.realpath(LUN)
    demand(re.fullmatch(r'/dev/nvme\d+n\d+', device) and stat.S_ISBLK(os.stat(device).st_mode), 'LUN0 is not a whole NVMe block device.')
    nvme = json.loads(run(['azure-nvme-id', '--format', 'json']))
    selected = [entry for entry in nvme if os.path.realpath(entry.get('path', '')) == device]
    demand(len(selected) == 1, 'Ambiguous NVMe identity.')
    udev = dict(line.split('=', 1) for line in run(['udevadm', 'info', '--query=property', '--name', LUN]).splitlines() if '=' in line)
    tree = flatten(json.loads(run(['lsblk', '--json', '--bytes', '--paths', '--output', 'NAME,TYPE,SIZE,PKNAME,FSTYPE,UUID,MOUNTPOINTS,MAJ:MIN']))['blockdevices'])
    rows = [row for row in tree if os.path.realpath(row['name']) == device]
    demand(len(rows) == 1, 'Ambiguous block-device tree.')
    root = json.loads(run(['findmnt', '--json', '--target', '/', '--output', 'MAJ:MIN']))['filesystems'][0]['maj:min']
    ancestors = set()
    matches = [row for row in tree if row['maj:min'] == root]
    demand(len(matches) == 1, 'Cannot establish unambiguous root disk ancestry.')
    current = matches[0]
    while current:
        demand(current['name'] not in ancestors, 'Ambiguous root ancestry.')
        ancestors.add(current['name'])
        parent = current.get('parent') or current.get('pkname')
        if parent and not parent.startswith('/'):
            parent = '/dev/' + parent
        if parent:
            matches = [row for row in tree if row['name'] == parent]
            demand(len(matches) == 1, 'Cannot resolve root disk ancestry.')
            current = matches[0]
        else:
            current = None
    demand(os.path.islink('/dev/disk/azure/os'), 'Missing Azure OS disk identity.')
    os_device = os.path.realpath('/dev/disk/azure/os')
    demand(os_device in ancestors, 'Azure OS mapping and root ancestry disagree.')
    mounts = run(['findmnt', '--json', '--mountpoint', MOUNT, '--output', 'TARGET,SOURCE,UUID,FSTYPE'], missing=True)
    return {
        'device': device, 'nvme': selected[0], 'udev': udev, 'block': rows[0],
        'rootAncestors': list(ancestors),
        'osDevice': os_device,
        'holders': os.listdir('/sys/class/block/' + os.path.basename(device) + '/holders'),
        'signatures': json.loads(run(['wipefs', '--json', '--no-act', LUN])).get('signatures', []),
        'mount': json.loads(mounts)['filesystems'][0] if mounts else None,
    }


def inspect(observation):
    device, block, udev = observation['device'], observation['block'], observation['udev']
    properties = observation['nvme'].get('properties', {})
    demand(properties.get('type') == 'data' and properties.get('lun') == 0,
           'Expected Azure managed data LUN0, never OS/local/resource storage.')
    # The packaged rules provide type/LUN even when azure-nvme-id --udev only emits AZURE_DISK_VS.
    demand(udev.get('AZURE_DISK_TYPE') == 'data' and udev.get('AZURE_DISK_LUN') == '0' and
           udev.get('DEVTYPE') == 'disk' and LUN in udev.get('DEVLINKS', '').split(), 'NVMe JSON and packaged udev mapping disagree.')
    demand(block.get('type') == 'disk' and int(block.get('size', 0)) == SIZE and
           not block.get('pkname') and not block.get('parent') and not block.get('children') and
           not observation['holders'], 'Wrong size, partitioned or busy data disk.')
    demand(device not in observation['rootAncestors'] and device != observation['osDevice'], 'Selected disk is OS/root ancestry.')


def same_identity(left, right):
    return all(left.get(key) == right.get(key) for key in IDENTITY)


def prepare(plan):
    valid_plan(plan)
    observed = probe()
    inspect(observed)
    saved, intent = read_state('disk'), read_state('disk-format-intent')
    if saved:
        demand(same_identity(saved, plan) and (not plan.get('fsUuid') or plan['fsUuid'] == saved['fsUuid']), 'Persistent disk identity differs.')
    else:
        demand(plan['allowFormat'] and not plan.get('fsUuid'), 'Existing disk has no tracked format permission/state.')
        if intent:
            demand(same_identity(intent, plan), 'Format intent belongs to another operation/disk.')
            demand(observed['block'].get('fstype') == 'ext4' and observed['block'].get('uuid') == intent['fsUuid'],
                   'Interrupted or ambiguous format; no second mkfs is allowed.')
            demand(not any(observed['block'].get('mountpoints') or []) and not observed['mount'], 'Interrupted format must be checked unmounted.')
            run(['e2fsck', '-fn', LUN])
            saved = intent
        else:
            demand(not observed['signatures'] and not observed['block'].get('fstype') and not observed['block'].get('uuid') and
                   not any(observed['block'].get('mountpoints') or []) and not observed['mount'], 'New disk is not blank and unmounted.')
            saved = {key: plan[key] for key in IDENTITY}
            saved['fsUuid'] = str(uuid.uuid4())
            write_state('disk-format-intent', saved)
            # Repeat all safety observations immediately before the one permitted mkfs.
            again = probe()
            inspect(again)
            demand(again['device'] == observed['device'] and not again['signatures'] and not again['block'].get('fstype') and
                   not again['block'].get('uuid') and not any(again['block'].get('mountpoints') or []) and not again['mount'], 'Disk changed before format.')
            run(['mkfs.ext4', '-q', '-U', saved['fsUuid'], LUN])
            observed = probe()
            inspect(observed)
            demand(observed['block'].get('fstype') == 'ext4' and observed['block'].get('uuid') == saved['fsUuid'], 'New filesystem verification failed.')
        write_state('disk', saved)
    demand(observed['block'].get('fstype') == 'ext4' and observed['block'].get('uuid') == saved['fsUuid'], 'Existing filesystem UUID/type differs; never reformat it.')
    demand(all(point == MOUNT for point in (observed['block'].get('mountpoints') or []) if point), 'Data disk is mounted elsewhere.')
    return saved


def check():
    saved = read_state('disk')
    demand(saved is not None, 'Missing disk binding.')
    observed = probe()
    inspect(observed)
    mounted = observed['mount'] or {}
    demand(observed['block'].get('fstype') == 'ext4' and observed['block'].get('uuid') == saved['fsUuid'] and
           mounted.get('target') == MOUNT and mounted.get('uuid') == saved['fsUuid'] and mounted.get('fstype') == 'ext4' and
           os.path.realpath(mounted.get('source', '')) == observed['device'], 'Missing or wrong mounted data filesystem; app start is prohibited.')
    return saved


if __name__ == '__main__':
    try:
        demand(os.geteuid() == 0, 'Root disk inspection is required.')
        if sys.argv[1:] == ['prepare']:
            result = prepare(json.load(sys.stdin))
        elif sys.argv[1:] == ['check']:
            result = check()
        else:
            raise RuntimeError('Unsupported disk command.')
        print(json.dumps(result, sort_keys=True))
    except Exception:
        print('Pilot disk safety gate failed; no unsafe fallback was attempted.', file=sys.stderr)
        sys.exit(1)
