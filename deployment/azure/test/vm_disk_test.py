"""Offline disk safety regressions: all device probes and commands are mocked."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    'vm_disk', Path(__file__).resolve().parents[1] / 'vm-disk.py')
disk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk)
FS_UUID = '77777777-7777-7777-7777-777777777777'
PLAN = {
    'operationId': '55555555-5555-5555-5555-555555555555',
    'vmUniqueId': '11111111-1111-1111-1111-111111111111',
    'diskId': disk.DISK_ID,
    'diskUniqueId': '33333333-3333-3333-3333-333333333333',
    'allowFormat': True,
    'fsUuid': None,
}
BINDING = {key: PLAN[key] for key in disk.IDENTITY} | {'fsUuid': FS_UUID}


def observation(device='/dev/nvme1n1', formatted=False, mounted=False):
    return {
        'device': device,
        'nvme': {'path': device, 'properties': {'type': 'data', 'lun': 0}},
        'udev': {'AZURE_DISK_TYPE': 'data', 'AZURE_DISK_LUN': '0',
                 'DEVTYPE': 'disk', 'DEVLINKS': disk.LUN},
        'block': {'name': device, 'type': 'disk', 'size': disk.SIZE,
                  'pkname': None, 'parent': None, 'maj:min': '259:3',
                  'fstype': 'ext4' if formatted else None,
                  'uuid': FS_UUID if formatted else None,
                  'mountpoints': [disk.MOUNT] if mounted else [None]},
        'rootAncestors': ['/dev/nvme0n1', '/dev/nvme0n1p1'],
        'osDevice': '/dev/nvme0n1', 'holders': [],
        'signatures': [{'type': 'ext4'}] if formatted else [],
        'mount': {'target': disk.MOUNT, 'source': device, 'uuid': FS_UUID,
                  'fstype': 'ext4'} if mounted else None,
    }


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.device = '/dev/nvme1n1'
        self.os_device = '/dev/nvme0n1'
        self.links = {disk.LUN, '/dev/disk/azure/os'}
        self.nvme = [{'path': self.device, 'properties': {'type': 'data', 'lun': 0}}]
        self.tree = [
            {'name': '/dev/nvme0n1', 'type': 'disk', 'size': disk.SIZE,
             'maj:min': '259:0', 'children': [
                 {'name': '/dev/nvme0n1p1', 'type': 'part', 'size': disk.SIZE,
                  'pkname': 'nvme0n1', 'maj:min': '259:2'}]},
            observation()['block'],
        ]
        self.root = '259:2'
        self.commands = []
        self.rules_present = True
        self.installed = True
        self.start_patch('run', side_effect=self.command)
        self.start_patch('os.path.islink', side_effect=lambda path: path in self.links)
        self.start_patch('os.path.isfile', side_effect=lambda path: self.rules_present and path == '/usr/lib/udev/rules.d/80-azure-disk.rules')
        self.start_patch('os.path.realpath', side_effect=lambda path: self.device if path == disk.LUN else self.os_device if path == '/dev/disk/azure/os' else path)
        self.start_patch('os.stat', side_effect=lambda path: SimpleNamespace(st_mode=stat.S_IFBLK) if path == self.device else self.fail('Unexpected device stat: ' + path))
        self.start_patch('os.listdir', side_effect=lambda path: [] if path == '/sys/class/block/' + self.device.removeprefix('/dev/') + '/holders' else self.fail('Unexpected sysfs read: ' + path))

    def start_patch(self, name, **kwargs):
        target = disk
        fields = name.split('.')
        for field in fields[:-1]:
            target = getattr(target, field)
        mock = patch.object(target, fields[-1], **kwargs)
        self.addCleanup(mock.stop)
        return mock.start()

    def command(self, args, missing=False):
        self.commands.append(args)
        if args[0] == 'dpkg-query':
            if '-W' in args:
                return 'install ok installed' if self.installed else 'not-installed'
            return '/usr/lib/udev/rules.d/80-azure-disk.rules\n'
        if args[:2] == ['udevadm', 'settle']:
            return ''
        if args[0] == 'azure-nvme-id':
            return json.dumps(self.nvme)
        if args[:2] == ['udevadm', 'info']:
            return '\n'.join(key + '=' + value for key, value in observation()['udev'].items())
        if args[0] == 'lsblk':
            return json.dumps({'blockdevices': self.tree})
        if args[0] == 'findmnt':
            if '--target' in args:
                return json.dumps({'filesystems': [{'maj:min': self.root}]})
            self.assertTrue(missing)
            return ''
        if args[0] == 'wipefs':
            self.assertIn('--no-act', args)
            return '{"signatures":[]}'
        self.fail('Unexpected or mutating device command: ' + repr(args))

    def test_nvme_enumeration_changes_follow_packaged_lun_not_a_fixed_number(self):
        for device in ['/dev/nvme1n1', '/dev/nvme7n4']:
            with self.subTest(device=device):
                self.device = device
                self.nvme[0]['path'] = device
                self.tree[1]['name'] = device
                result = disk.probe()
                disk.inspect(result)
                self.assertEqual(result['device'], device)
                self.assertEqual(set(result['rootAncestors']), {'/dev/nvme0n1', '/dev/nvme0n1p1'})
        self.assertFalse(any(args[0] == 'mkfs.ext4' for args in self.commands))

    def test_missing_lun_symlink_never_guesses_a_device(self):
        self.links.remove(disk.LUN)
        with self.assertRaisesRegex(RuntimeError, 'Missing Azure data LUN0'):
            disk.probe()

    def test_missing_package_or_rules_fails(self):
        self.installed = False
        with self.assertRaisesRegex(RuntimeError, 'azure-vm-utils is required'):
            disk.probe()
        self.installed = True
        self.rules_present = False
        with self.assertRaisesRegex(RuntimeError, 'udev rules are required'):
            disk.probe()

    def test_non_whole_nvme_symlink_is_rejected(self):
        self.device = '/dev/nvme1n1p1'
        with self.assertRaisesRegex(RuntimeError, 'whole NVMe'):
            disk.probe()

    def test_ambiguous_nvme_identity_is_rejected(self):
        self.nvme *= 2
        with self.assertRaisesRegex(RuntimeError, 'Ambiguous NVMe'):
            disk.probe()

    def test_missing_or_disagreeing_os_mapping_is_rejected(self):
        self.links.remove('/dev/disk/azure/os')
        with self.assertRaisesRegex(RuntimeError, 'Missing Azure OS'):
            disk.probe()
        self.links.add('/dev/disk/azure/os')
        self.os_device = self.device
        with self.assertRaisesRegex(RuntimeError, 'root ancestry disagree'):
            disk.probe()

    def test_unresolved_root_parent_and_missing_root_are_rejected(self):
        self.tree[0]['children'][0]['children'] = [
            {'name': '/dev/dm-0', 'type': 'crypt', 'maj:min': '253:0'}]
        self.root = '253:0'
        self.assertIn('/dev/nvme0n1', disk.probe()['rootAncestors'])
        self.tree[0]['children'] = []
        self.tree.append({'name': '/dev/dm-0', 'type': 'crypt', 'pkname': 'missing', 'maj:min': '253:0'})
        with self.assertRaisesRegex(RuntimeError, 'Cannot resolve root disk ancestry'):
            disk.probe()
        self.root = '999:99'
        with self.assertRaisesRegex(RuntimeError, 'unambiguous root disk ancestry'):
            disk.probe()


class InspectTests(unittest.TestCase):
    def test_only_exact_whole_managed_data_lun_zero_is_accepted(self):
        disk.inspect(observation())
        mutations = {
            'OS': lambda o: o['nvme']['properties'].update(type='os'),
            'local': lambda o: o['nvme']['properties'].update(type='local'),
            'wrong LUN': lambda o: o['nvme']['properties'].update(lun=1),
            'udev type': lambda o: o['udev'].update(AZURE_DISK_TYPE='os'),
            'udev LUN': lambda o: o['udev'].update(AZURE_DISK_LUN='1'),
            'udev device': lambda o: o['udev'].update(DEVTYPE='partition'),
            'udev links': lambda o: o['udev'].update(DEVLINKS='/dev/foreign'),
            'partitions': lambda o: o['block'].update(children=[{'name': '/dev/fake-part'}]),
            'partition type': lambda o: o['block'].update(type='part'),
            'parent': lambda o: o['block'].update(parent='/dev/fake-parent'),
            'pkname': lambda o: o['block'].update(pkname='fake-parent'),
            'holders': lambda o: o.update(holders=['dm-0']),
            'wrong size': lambda o: o['block'].update(size=disk.SIZE + 1),
            'root ancestry': lambda o: o['rootAncestors'].append(o['device']),
            'OS mapping': lambda o: o.update(osDevice=o['device']),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                observed = observation()
                mutate(observed)
                with self.assertRaises(RuntimeError):
                    disk.inspect(observed)


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.observed = observation()
        self.saved = {}
        self.events = []
        self.plan = copy.deepcopy(PLAN)
        self.fail_mkfs = False
        self.fail_disk_save = False
        self.fail_fsck = False
        self.patch('probe', side_effect=lambda: copy.deepcopy(self.observed))
        self.patch('read_state', side_effect=lambda name: copy.deepcopy(self.saved.get(name)))
        self.patch('write_state', side_effect=self.write)
        self.command_mock = self.patch('run', side_effect=self.command)
        self.patch('uuid.uuid4', return_value=FS_UUID)

    def patch(self, name, **kwargs):
        target = disk
        fields = name.split('.')
        for field in fields[:-1]:
            target = getattr(target, field)
        mock = patch.object(target, fields[-1], **kwargs)
        self.addCleanup(mock.stop)
        return mock.start()

    def write(self, name, value):
        self.events.append(('save', name))
        if name == 'disk' and self.fail_disk_save:
            raise RuntimeError('fixture power failure before disk binding')
        self.assertNotIn(name, self.saved, 'Bindings must never be overwritten')
        self.saved[name] = copy.deepcopy(value)

    def command(self, args, missing=False):
        self.events.append(('run', args))
        if args[0] == 'mkfs.ext4':
            self.assertEqual(args, ['mkfs.ext4', '-q', '-U', FS_UUID, disk.LUN])
            self.assertEqual(self.saved['disk-format-intent'], BINDING)
            self.assertNotIn('disk', self.saved)
            if self.fail_mkfs:
                raise RuntimeError('fixture interrupted mkfs')
            self.observed = observation(formatted=True)
            return ''
        if args[0] == 'e2fsck':
            self.assertEqual(args, ['e2fsck', '-fn', disk.LUN])
            if self.fail_fsck:
                raise RuntimeError('fixture read-only fsck found corruption')
            return ''
        self.fail('Unmocked or unexpected device command: ' + repr(args))

    def test_exact_new_blank_disk_records_intent_before_one_nonforce_mkfs(self):
        self.assertEqual(disk.prepare(self.plan), BINDING)
        self.assertEqual(self.events, [
            ('save', 'disk-format-intent'),
            ('run', ['mkfs.ext4', '-q', '-U', FS_UUID, disk.LUN]),
            ('save', 'disk'),
        ])
        self.plan.update(allowFormat=False, fsUuid=FS_UUID)
        self.assertEqual(disk.prepare(self.plan), BINDING)
        self.assertEqual(self.command_mock.call_count, 1, 'Known filesystems are reused, never reformatted')

    def test_no_explicit_format_permission_never_formats(self):
        for patch_plan in [{'allowFormat': False}, {'fsUuid': FS_UUID}, {'diskId': '/foreign'}, {'allowFormat': 1}]:
            with self.subTest(patch_plan=patch_plan):
                with self.assertRaises(RuntimeError):
                    disk.prepare(self.plan | patch_plan)
        self.assertEqual(self.events, [])

    def test_nonblank_or_mounted_disk_never_gets_an_intent(self):
        for patch_block, patch_observation in [
            ({'fstype': 'ext4'}, {}), ({'uuid': FS_UUID}, {}),
            ({}, {'signatures': [{'type': 'gpt'}]}),
            ({'mountpoints': ['/other']}, {}), ({}, {'mount': {'target': disk.MOUNT}}),
        ]:
            with self.subTest(patch_block=patch_block, patch_observation=patch_observation):
                self.observed = observation()
                self.observed['block'].update(patch_block)
                self.observed.update(patch_observation)
                with self.assertRaisesRegex(RuntimeError, 'not blank and unmounted'):
                    disk.prepare(self.plan)
                self.assertEqual(self.events, [])

    def test_disk_changes_on_second_probe_abort_before_mkfs(self):
        first = observation()
        for changed in [observation('/dev/nvme8n1'), observation(formatted=True), observation(mounted=True)]:
            with self.subTest(changed=changed):
                self.saved.clear()
                self.events.clear()
                with patch.object(disk, 'probe', side_effect=[first, changed]):
                    with self.assertRaisesRegex(RuntimeError, 'changed before format'):
                        disk.prepare(self.plan)
                self.assertEqual(self.events, [('save', 'disk-format-intent')])

    def test_intent_before_failed_mkfs_blocks_any_second_format(self):
        self.fail_mkfs = True
        with self.assertRaisesRegex(RuntimeError, 'interrupted mkfs'):
            disk.prepare(self.plan)
        self.assertIn('disk-format-intent', self.saved)
        with self.assertRaisesRegex(RuntimeError, 'no second mkfs'):
            disk.prepare(self.plan)
        self.assertEqual(self.command_mock.call_count, 1)
        self.assertNotIn('disk', self.saved)

    def test_completed_format_recovers_from_intent_only_after_readonly_fsck(self):
        self.fail_disk_save = True
        with self.assertRaisesRegex(RuntimeError, 'power failure'):
            disk.prepare(self.plan)
        self.assertEqual(self.observed['block']['uuid'], FS_UUID)
        self.assertNotIn('disk', self.saved)
        self.fail_disk_save = False
        self.assertEqual(disk.prepare(self.plan), BINDING)
        self.assertEqual([call.args[0][0] for call in self.command_mock.call_args_list], ['mkfs.ext4', 'e2fsck'])
        self.assertEqual(self.saved['disk'], BINDING)

    def test_corrupt_interrupted_filesystem_fails_without_binding_or_reformat(self):
        self.saved['disk-format-intent'] = copy.deepcopy(BINDING)
        self.observed = observation(formatted=True)
        self.fail_fsck = True
        with self.assertRaisesRegex(RuntimeError, 'corruption'):
            disk.prepare(self.plan)
        self.assertNotIn('disk', self.saved)
        self.assertEqual(self.command_mock.call_args.args[0], ['e2fsck', '-fn', disk.LUN])

    def test_interrupted_wrong_uuid_mount_or_identity_cannot_recover(self):
        cases = [
            (BINDING, observation()),
            (BINDING, observation(formatted=True, mounted=True)),
            (BINDING | {'diskUniqueId': 'other'}, observation(formatted=True)),
            (BINDING | {'fsUuid': 'other'}, observation(formatted=True)),
        ]
        for intent, observed in cases:
            with self.subTest(intent=intent, observed=observed):
                self.saved = {'disk-format-intent': intent}
                self.observed = observed
                with self.assertRaises(RuntimeError):
                    disk.prepare(self.plan)
                self.command_mock.assert_not_called()
                self.assertNotIn('disk', self.saved)

    def test_known_filesystem_identity_uuid_and_mount_drift_never_reformat(self):
        self.saved['disk'] = copy.deepcopy(BINDING)
        for mutate in [
            lambda o: o['block'].update(uuid='different'),
            lambda o: o['block'].update(fstype='xfs'),
            lambda o: o['block'].update(mountpoints=['/other']),
        ]:
            self.observed = observation(formatted=True)
            mutate(self.observed)
            with self.assertRaises(RuntimeError):
                disk.prepare(self.plan)
        for key in disk.IDENTITY:
            with self.assertRaises(RuntimeError):
                disk.prepare(self.plan | {key: 'different'})
        self.command_mock.assert_not_called()

    def test_startup_requires_binding_and_exact_mounted_uuid_source_type(self):
        with self.assertRaisesRegex(RuntimeError, 'Missing disk binding'):
            disk.check()
        self.saved['disk'] = copy.deepcopy(BINDING)
        self.observed = observation(formatted=True, mounted=True)
        # Resolve fixture paths without ever consulting a host /dev symlink.
        with patch.object(disk.os.path, 'realpath', side_effect=lambda path: path):
            self.assertEqual(disk.check(), BINDING)
            for mutate in [
                lambda o: o.update(mount=None),
                lambda o: o['mount'].update(uuid='different'),
                lambda o: o['mount'].update(source='/dev/foreign'),
                lambda o: o['mount'].update(target='/other'),
                lambda o: o['mount'].update(fstype='xfs'),
                lambda o: o['block'].update(uuid='different'),
            ]:
                with self.subTest(mutate=mutate):
                    self.observed = observation(formatted=True, mounted=True)
                    mutate(self.observed)
                    with self.assertRaisesRegex(RuntimeError, 'app start is prohibited'):
                        disk.check()
        self.command_mock.assert_not_called()


class StateFileTests(unittest.TestCase):
    def setUp(self):
        os.makedirs('/tmp/opencode', exist_ok=True)
        directory = tempfile.TemporaryDirectory(prefix='opendots-disk-test-', dir='/tmp/opencode')
        self.addCleanup(directory.cleanup)
        self.base = Path(directory.name)
        patcher = patch.object(disk, 'BASE', directory.name)
        patcher.start()
        self.addCleanup(patcher.stop)
        # No state-file test is permitted to execute a device command.
        guard = patch.object(disk, 'run', side_effect=AssertionError('Device command in state file test'))
        guard.start()
        self.addCleanup(guard.stop)

    def test_private_atomic_exclusive_publication_for_intent_and_binding(self):
        for name in ['disk-format-intent', 'disk']:
            path = self.base / (name + '.json')
            real_link = os.link

            def checked_link(source, destination):
                self.assertFalse(os.path.lexists(destination))
                self.assertEqual(json.loads(Path(source).read_text()), BINDING)
                self.assertEqual(stat.S_IMODE(os.lstat(source).st_mode), 0o600)
                return real_link(source, destination)

            with patch.object(disk.os, 'link', side_effect=checked_link), patch.object(disk.os, 'fsync', wraps=os.fsync) as sync:
                disk.write_state(name, BINDING)
                self.assertEqual(sync.call_count, 2, 'File and parent directory must both be synced')
            self.assertEqual(json.loads(path.read_text()), BINDING)
            self.assertEqual(stat.S_IMODE(path.lstat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                disk.write_state(name, BINDING | {'fsUuid': 'changed'})
            self.assertEqual(json.loads(path.read_text()), BINDING)
            self.assertFalse(any(item.name.startswith('.') for item in self.base.iterdir()))

    def test_symlink_state_is_not_followed_or_overwritten(self):
        sentinel = self.base / 'sentinel'
        sentinel.write_text('fixture-sentinel')
        os.chmod(sentinel, 0o600)
        for name in ['disk', 'disk-format-intent']:
            path = self.base / (name + '.json')
            path.symlink_to(sentinel)
            with self.assertRaisesRegex(RuntimeError, 'root-owned private regular'):
                disk.read_state(name)
            with self.assertRaises(FileExistsError):
                disk.write_state(name, BINDING)
            self.assertTrue(path.is_symlink())
            self.assertEqual(sentinel.read_text(), 'fixture-sentinel')

    def test_read_state_keeps_root_ownership_and_private_regular_file_checks(self):
        self.assertIsNone(disk.read_state('disk'))
        disk.write_state('disk', BINDING)
        if os.getuid() == 0:
            self.assertEqual(disk.read_state('disk'), BINDING)
        else:
            with self.assertRaisesRegex(RuntimeError, 'root-owned private regular'):
                disk.read_state('disk')
        os.chmod(self.base / 'disk.json', 0o644)
        with self.assertRaisesRegex(RuntimeError, 'root-owned private regular'):
            disk.read_state('disk')
        (self.base / 'disk.json').unlink()
        (self.base / 'disk.json').mkdir(mode=0o700)
        with self.assertRaisesRegex(RuntimeError, 'root-owned private regular'):
            disk.read_state('disk')

    def test_failed_atomic_publication_leaves_no_binding_or_temporary_file(self):
        with patch.object(disk.os, 'link', side_effect=OSError('fixture publication failure')):
            with self.assertRaises(OSError):
                disk.write_state('disk', BINDING)
        self.assertEqual(list(self.base.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
