"""Fixed read-only checks appended to the unchanged initial-recovery definitions."""


def check_initial(plan):
    demand(os.geteuid() == 0 and plan['binding']['vmId'] == VM_ID and plan['binding']['diskId'] == DISK_ID)
    systemd = directory('/etc/systemd/system')
    try:
        unit = read(systemd, 'opendots.service', 0o644)
        demand(digest(unit) == plan['unitSha256'])
        demand(digest(read(systemd, 'srv-opendots.mount', 0o644)) == plan['mountSha256'])
        # Includes immutable helpers, bound NVMe/mounted UUID, empty data/runtime/images/containers and no activation history/job.
        effective(pristine(plan), unit, plan['image'])
    finally:
        os.close(systemd)


def check_caddy(plan):
    demand(os.geteuid() == 0 and plan['binding']['vmId'] == VM_ID)
    config = directory('/etc/opendots')
    try:
        demand(digest(read(config, 'Caddyfile', 0o644)) == plan['caddySha256'])
    finally:
        os.close(config)
    dropin = directory('/etc/systemd/system/caddy.service.d')
    try:
        demand(digest(read(dropin, 'opendots.conf', 0o644)) == plan['caddyServiceSha256'])
    finally:
        os.close(dropin)
    run(['/usr/bin/sudo', '-n', '-u', 'caddy', '--', '/usr/bin/test', '-r', '/etc/opendots/Caddyfile'])
    fields = ['LoadState', 'ActiveState', 'SubState', 'User', 'DropInPaths', 'Job', 'NeedDaemonReload']
    text = run(['/usr/bin/systemctl', 'show', 'caddy.service', '--no-pager', '--property=' + ','.join(fields)])
    lines = [line.split('=', 1) for line in text.splitlines()]
    demand(len(lines) == len(fields) and all(len(line) == 2 for line in lines))
    value = dict(lines)
    demand(set(value) == set(fields) and value['LoadState'] == 'loaded' and value['ActiveState'] == 'active' and
           value['SubState'] == 'running' and value['User'] == 'caddy' and value['Job'] in ('', '0') and
           value['NeedDaemonReload'] == 'no' and value['DropInPaths'] == '/etc/systemd/system/caddy.service.d/opendots.conf')
