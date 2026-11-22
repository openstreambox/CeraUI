"""Guest init and hostapd hotspot credential checks."""

import os
from pathlib import Path
import re
import signal
import socket
import struct
import subprocess
import time
import traceback


AP = "192.0.2.1"
STA = {"a": "02:00:00:00:00:0a", "b": "02:00:00:00:00:0b"}
WILDCARD = "00:00:00:00:00:00"
FIRST = "fixture-password-first"
SECOND = "fixture-password-second"
STANDING = "fixture-password-standing"
EXPIRY_CONTROL = "fixture-password-expiry-control"
PSK_FILE = Path("/run/psks")
SAE_FILE = Path("/run/sae-passwords")
AP_CONFIG = Path("/run/hostapd.conf")
WORKERS = {}
RESULTS = {}
# Linux x86-64 SO_TIMESTAMPNS (native 64-bit timespec), the launcher ABI.
SO_TIMESTAMPNS = 35
TIMESPEC = struct.Struct("@ll")
LIFECYCLE = re.compile(r"^<\d+>AP-STA-(CONNECTED|DISCONNECTED) (\S+)(?: |$)")


def run(*command, namespace=None, check=True):
    if namespace:
        command = ("ip", "netns", "exec", namespace, *command)
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=10)
    if check and result.returncode:
        raise RuntimeError(f"{command}: {result.stdout.strip()}")
    return result.stdout.strip()


def launch(name, namespace, *command):
    with Path(f"/run/{name}.log").open("w") as log:
        process = subprocess.Popen(("ip", "netns", "exec", namespace, *command),
                                   stdout=log, stderr=subprocess.STDOUT)
    WORKERS[name] = process
    return process


def stop(name):
    process = WORKERS.pop(name, None)
    if process:
        process.terminate()
        process.wait(timeout=5)


def log(name):
    return Path(f"/run/{name}.log").read_text()


def until(predicate, seconds=8):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.02)
    return None


def report(step, passed, evidence):
    RESULTS[step] = bool(passed)
    print(f"{'PASS' if passed else 'FAIL'} {step} {evidence}")
    return bool(passed)


class Control:
    def __init__(self, remote, name):
        self.address = Path(f"/run/control-{name}")
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        self.socket.bind(str(self.address))
        self.socket.connect(str(remote))

    def command(self, command):
        self.socket.settimeout(2)
        self.socket.send(command.encode())
        return self.socket.recv(16384).decode().strip()

    def attach(self):
        self.socket.setsockopt(socket.SOL_SOCKET, SO_TIMESTAMPNS, 1)
        return self.command("ATTACH") == "OK"

    def receive_event(self, seconds):
        self.socket.settimeout(seconds)
        data, ancillary, flags, _ = self.socket.recvmsg(16384, socket.CMSG_SPACE(TIMESPEC.size))
        if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
            raise RuntimeError("Truncated hostapd control event")
        for level, kind, value in ancillary:
            if (level, kind) == (socket.SOL_SOCKET, SO_TIMESTAMPNS):
                whole, nanos = TIMESPEC.unpack(value)
                return data.decode().strip(), whole + nanos / 1e9
        raise RuntimeError("No kernel receive timestamp on hostapd control event")

    def event(self, pattern, seconds=8, *, since=0):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                event, received = self.receive_event(max(0.001, deadline - time.monotonic()))
            except TimeoutError:
                break
            if received >= since and re.search(pattern, event):
                return event, received
        return "", 0

    def transitions(self, since, through):
        changes = []
        while True:
            try:
                event, received = self.receive_event(max(0.001, through - time.time()))
            except TimeoutError:
                return changes
            if since <= received <= through and (match := LIFECYCLE.match(event)):
                kind, mac = match.groups()
                changes.append((kind, mac, received))

    def close(self):
        self.socket.close()
        self.address.unlink()


def radios():
    run("modprobe", "mac80211_hwsim", "radios=3")
    phys = re.findall(r"^phy#(\d+)", run("iw", "dev"), re.M)
    if len(phys) != 3:
        raise RuntimeError(f"Expected 3 hwsim phys, got {phys}")
    for phy, namespace in zip(sorted(phys, key=int), ("ap", "a", "b"), strict=True):
        run("ip", "netns", "add", namespace)
        run("iw", "phy", f"phy{phy}", "set", "netns", "name", namespace)
        interface = re.search(r"Interface (\S+)", run("iw", "dev", namespace=namespace))[1]
        run("ip", "link", "set", interface, "name", "testwifi", namespace=namespace)
        run("ip", "link", "set", "lo", "up", namespace=namespace)
        if namespace in STA:
            run("ip", "link", "set", "testwifi", "address", STA[namespace], namespace=namespace)
    run("ip", "address", "add", f"{AP}/24", "dev", "testwifi", namespace="ap")
    report(1, True, "three simulated radios in separate AP, A and B namespaces")


def atomic_write(path, configuration):
    replacement = path.with_suffix(".new")
    replacement.write_text(configuration)
    replacement.replace(path)


def psks(*entries):
    atomic_write(PSK_FILE, "".join(f"keyid={key} {mac} {secret}\n" for key, mac, secret in entries))


def ap_config(security):
    atomic_write(AP_CONFIG, (
        "interface=testwifi\ndriver=nl80211\nssid=HostapdFixture\n"
        "hw_mode=g\nchannel=6\nctrl_interface=/run/ap\n"
        "wpa=2\nrsn_pairwise=CCMP\nlogger_stdout=-1\nlogger_stdout_level=0\n" + security
    ))


def start_ap():
    launch("ap", "ap", "hostapd", "-t", "-d", str(AP_CONFIG))
    remote = Path("/run/ap/testwifi")
    if not until(remote.exists):
        raise RuntimeError("hostapd control socket did not appear")
    control = Control(remote, "ap")
    events = Control(remote, "ap-events")
    if not until(lambda: "state=ENABLED" in control.command("STATUS")) or not events.attach():
        raise RuntimeError("hostapd did not become ready")
    return control, events


def station(name, secret, sae=False, identifier=None):
    stop(name)
    if sae:
        password = f'key_mgmt=SAE\nieee80211w=2\nsae_password="{secret}"\n'
        if identifier is not None:
            password += f'sae_password_id="{identifier}"\n'
    else:
        password = f'key_mgmt=WPA-PSK\npsk="{secret}"\n'
    config = Path(f"/run/station-{name}.conf")
    config.write_text(
        f"ctrl_interface=/run/station-{name}\nsae_pwe=1\nnetwork={{\n"
        f'ssid="HostapdFixture"\nscan_freq=2437\n{password}}}\n'
    )
    launch(name, name, "wpa_supplicant", "-t", "-i", "testwifi", "-c", str(config))


def authorized(station_name):
    status = run("iw", "dev", "testwifi", "station", "dump", namespace="ap")
    return station_authorized(status, STA[station_name])


def station_authorized(status, mac):
    if not status:
        return False
    stations = re.split(r"^Station ", status, flags=re.M)
    if stations[0] or len(stations) == 1:
        raise RuntimeError(f"Unexpected iw station dump: {status}")
    for station_status in stations[1:]:
        if station_status.split()[0].lower() == mac:
            match = re.search(r"^\s*authorized:\s+(yes|no)\s*$", station_status, re.M)
            if not match:
                raise RuntimeError(f"iw station dump omitted authorization for {mac}")
            return match[1] == "yes"
    return False


def give_lease():
    hook = Path("/run/dhcp-hook")
    hook.write_text(
        '#!/bin/sh\n'
        '[ "$1" != bound ] || ip addr replace "$ip/24" dev "$interface"\n'
    )
    hook.chmod(0o755)
    lease = run("busybox", "udhcpc", "-f", "-q", "-n", "-t", "3", "-T", "1",
                "-i", "testwifi", "-s", str(hook), namespace="a")
    return re.search(r"lease of (192\.0\.2\.\d+) obtained", lease)


def reload_psks(control):
    return control.command("RELOAD_WPA_PSK") == "OK"


def ping_timestamps(output):
    return [float(value) for value in re.findall(r"^\[(\d+\.\d+)\].*icmp_seq=\d+", output, re.M)]


def ping_brackets(output, sent_at, completed_at):
    stamps = ping_timestamps(output)
    before = sum(stamp < sent_at for stamp in stamps)
    after = sum(stamp > completed_at for stamp in stamps)
    clean = len(stamps) == 30 and "30 packets transmitted, 30 received" in output
    return clean and before > 0 and after > 0, before, after


def continuous_ping(name, events, mutation):
    baseline = time.time()
    was_authorized = authorized("a")
    process = launch(name, "a", "ping", "-D", "-n", "-i", "0.04", "-c", "30", "-W", "1", AP)
    if not until(lambda: ping_timestamps(log(name)), 2):
        raise RuntimeError("Ping did not establish traffic before reload")
    reloaded, sent_at, completed_at = mutation()
    process.wait(timeout=5)
    clean, before, after = ping_brackets(log(name), sent_at, completed_at)
    still_authorized = authorized("a")
    changes = events.transitions(baseline, time.time() + 0.15)
    a_transitions = [kind for kind, mac, _ in changes if mac == STA["a"]]
    passed = reloaded and clean and was_authorized and still_authorized and not a_transitions
    return passed, f"ping={len(ping_timestamps(log(name)))}/30 before={before} after={after} A_transitions={a_transitions}"


def peer_event(events, kind, name, since, seconds=8):
    return events.event(rf"^<\d+>{kind} {STA[name]}(?: |$)", seconds, since=since)


def connect(events, name, secret, *, sae=False, identifier=None):
    stop(name)
    if not until(lambda: not authorized(name), 2):
        raise RuntimeError(f"Station {name} remained authorized before fresh join")
    started = time.time()
    station(name, secret, sae=sae, identifier=identifier)
    return peer_event(events, "AP-STA-CONNECTED", name, started)


def denied_psk(events, secret, empty_candidates=False):
    stop("b")
    if not until(lambda: not authorized("b"), 2):
        raise RuntimeError("Station B remained authorized before PSK rejection check")
    offset = len(log("ap"))
    started = time.time()
    station("b", secret)
    if empty_candidates:
        denial = until(lambda: re.search(
            r"STA " + STA["b"] + r".*no PSK configured for the STA", log("ap")[offset:],
        ))
        evidence = "no PSK configured for B" if denial else "no missing-PSK diagnostic"
    else:
        denial, _ = peer_event(events, "AP-STA-POSSIBLE-PSK-MISMATCH", "b", started)
        evidence = denial or "no PSK mismatch event"
    accepted = authorized("b") or "CTRL-EVENT-CONNECTED" in log("b")
    if not denial:
        print("\n".join(line for line in log("ap")[offset:].splitlines()
                        if any(word in line.lower() for word in ("psk", "reject", "status code")))[-3000:])
    stop("b")
    return bool(denial) and not accepted and "CTRL-EVENT-CONNECTED" not in log("b"), evidence


def psk_mutation(control, *entries):
    psks(*entries)
    sent_at = time.time()
    reloaded = reload_psks(control)
    return reloaded, sent_at, time.time()


def expiry_passed(armed, control_join, control_authorized, elapsed, expected, clean, denied):
    return (armed and control_join.endswith(" keyid=expiry-control") and control_authorized
            and expected <= elapsed <= expected + 0.25 and clean and denied)


def revocation_passed(reloaded, baseline, final, changes, sent_at):
    if not reloaded or baseline != (True, True) or final != (False, True) or len(changes) != 1:
        return False
    kind, mac, received = changes[0]
    return kind == "DISCONNECTED" and mac == STA["a"] and sent_at <= received <= sent_at + 1


def wpa2(expiry_seconds):
    unused = ("otp-2", WILDCARD, SECOND)
    bound = ("dev-a", STA["a"], FIRST)
    standing = ("standing", WILDCARD, STANDING)
    psks(("otp-1", WILDCARD, FIRST))
    ap_config(f"wpa_key_mgmt=WPA-PSK\nwpa_psk_file={PSK_FILE}\n")
    control, events = start_ap()
    launch("dhcp", "ap", "dnsmasq", "--keep-in-foreground", "--conf-file=/dev/null",
           "--port=0", "--interface=testwifi", "--bind-interfaces", "--log-facility=-", "--log-dhcp",
           "--dhcp-broadcast", "--dhcp-range=192.0.2.10,192.0.2.20,255.255.255.0,1h",
           "--dhcp-leasefile=/run/leases", "--pid-file=/run/dnsmasq.pid", "--user=root")
    joined, received = connect(events, "a", FIRST)
    if not joined or not until(lambda: authorized("a")):
        raise RuntimeError("A did not authenticate with the initial WPA2 PSK")
    lease = give_lease()
    report(2, lease, f"hostapd and wpa_supplicant joined; dnsmasq lease={lease[1] if lease else 'missing'}")
    timestamps = re.findall(
        r"^(\d+\.\d+): .*STA " + STA["a"] + r" IEEE 802\.11: associated(?:\s|$)",
        log("ap"), re.M,
    )
    elapsed = (received - float(timestamps[-1])) * 1000 if timestamps else float("nan")
    current = control.command("STA " + STA["a"])
    sta_key = re.search(r"^keyid=(\S+)", current, re.M)
    report(3, joined.endswith(" keyid=otp-1") and sta_key and sta_key[1] == "otp-1" and 0 <= elapsed <= 100,
           f"association_to_event_ms={elapsed:.3f} event={joined} sta_keyid={sta_key[1] if sta_key else 'absent'}")

    clean, traffic = continuous_ping("binding-ping", events, lambda: psk_mutation(control, bound))
    report(4, clean, traffic)
    no_candidate, no_candidate_evidence = denied_psk(events, FIRST, empty_candidates=True)
    psks(bound, standing)
    active = reload_psks(control)
    mismatch, mismatch_evidence = denied_psk(events, FIRST)
    report(5, active and no_candidate and mismatch,
           f"B denied with and without another eligible PSK: {no_candidate_evidence}; {mismatch_evidence}")

    psks(bound, standing, unused, ("expiry-control", WILDCARD, EXPIRY_CONTROL))
    armed = reload_psks(control)
    started = time.monotonic()
    deadline = started + expiry_seconds
    control_join, _ = connect(events, "b", EXPIRY_CONTROL)
    control_authorized = authorized("b")
    stop("b")
    time.sleep(max(0, deadline - time.monotonic() - 0.25))

    def expire():
        nonlocal elapsed
        time.sleep(max(0, deadline - time.monotonic()))
        result = psk_mutation(control, bound, standing)
        elapsed = time.monotonic() - started
        return result

    elapsed = float("inf")
    clean, traffic = continuous_ping("expiry-ping", events, expire)
    denied, evidence = denied_psk(events, SECOND)
    report(6, expiry_passed(armed, control_join, control_authorized, elapsed, expiry_seconds, clean, denied),
           f"expiry_reload_ms={elapsed * 1000:.3f} control_join={control_join!r} "
           f"control_authorized={control_authorized} {traffic} expired_B={evidence}")

    peer, _ = connect(events, "b", STANDING)
    psks(standing)
    baseline_at = time.time()
    baseline = authorized("a"), authorized("b")
    sent_at = time.time()
    reloaded = reload_psks(control)
    changes = events.transitions(baseline_at, sent_at + 1)
    final = authorized("a"), authorized("b")
    elapsed = next(((stamp - sent_at) * 1000 for kind, mac, stamp in changes
                    if kind == "DISCONNECTED" and mac == STA["a"]), float("inf"))
    report(7, peer and revocation_passed(reloaded, baseline, final, changes, sent_at),
           f"reload_to_disconnect_ms={elapsed:.3f} baseline={baseline} final={final} transitions={changes}")
    stop("a")
    stop("b")
    stop("dhcp")
    events.close()
    control.close()
    stop("ap")


def sae_config(*credentials):
    settings = "wpa_key_mgmt=SAE\nieee80211w=2\nsae_pwe=1\ndisable_pmksa_caching=1\n"
    ap_config(settings + "".join(f"sae_password={entry}\n" for entry in credentials))


def set_sae_passwords(control, *credentials):
    # The file form appends entries. Neither SET prepares the H2E elements.
    atomic_write(SAE_FILE, "".join(f"{entry}\n" for entry in credentials))
    return (control.command("SET sae_password ") == "OK"
            and control.command(f"SET sae_password_file {SAE_FILE}") == "OK")


def sae_joins(events, name, secret, identifier=None):
    event, _ = connect(events, name, secret, sae=True, identifier=identifier)
    return event if event and authorized(name) else ""


def sae_join_has_no_id(event, reply, mac):
    lines = reply.splitlines()
    if not lines or lines[0] != mac:
        return False
    flags = next((line for line in lines if line.startswith("flags=")), "")
    identifier = re.compile(r"\b(?:keyid|sae_password_id)=", re.I)
    return (bool(re.match(rf"^<\d+>AP-STA-CONNECTED {mac}(?: |$)", event))
            and "[AUTHORIZED]" in flags and not identifier.search(event)
            and not identifier.search(reply))


def sae_rejection(ap_log, mac, since):
    for line in ap_log.splitlines():
        match = re.match(r"^(\d+\.\d+): (.*)", line)
        if not match or float(match[1]) < since:
            continue
        diagnostic = match[2]
        if re.search(rf"SAE-UNKNOWN-PASSWORD-IDENTIFIER {mac}(?: |$)", diagnostic):
            return True
        if re.search(rf"authentication reply: STA={mac} auth_alg=3 auth_transaction=1 "
                     r"resp=(?:1|123)\b", diagnostic):
            return True
    return False


def sae_denied(name, secret, identifier=None):
    stop(name)
    if not until(lambda: not authorized(name), 2):
        raise RuntimeError(f"Station {name} remained authorized before SAE rejection check")
    offset = len(log("ap"))
    started = time.time()
    station(name, secret, sae=True, identifier=identifier)

    def rejected():
        return sae_rejection(log("ap")[offset:], STA[name], started)

    until(lambda: rejected() or authorized(name), 6)
    denied = rejected() and not authorized(name) and "CTRL-EVENT-CONNECTED" not in log(name)
    if not denied:
        print("\n".join(line for line in log("ap")[offset:].splitlines()
                        if any(word in line for word in ("SAE:", "authentication")))[-3000:])
    stop(name)
    return denied and "CTRL-EVENT-CONNECTED" not in log(name)


def sae_reload(events, mutation, *peers):
    baseline_at = time.time()
    baseline = all(authorized(peer) for peer in peers)
    started = time.time()
    result = mutation()
    changes = events.transitions(baseline_at, started + 2)
    wanted = {STA[peer] for peer in peers}
    disconnected = {mac for kind, mac, stamp in changes if kind == "DISCONNECTED" and stamp >= started}
    before = [change for change in changes if change[2] < started and change[1] in wanted]
    print(f"SAE reload expected={sorted(wanted)} disconnects={sorted(disconnected)} baseline={baseline}")
    return result, baseline and not before and disconnected == wanted


def wpa3():
    first = f"{FIRST}|id=first"
    second = f"{SECOND}|id=second"
    bound_first = f"{FIRST}|mac={STA['a']}|id=first"
    sae_config(first, second)
    control, events = start_ap()
    missing_id = sae_denied("a", FIRST)
    joined_a = sae_joins(events, "a", FIRST, "first")
    sta_a = control.command(f"STA {STA['a']}")
    joined_b = sae_joins(events, "b", SECOND, "second")
    sta_b = control.command(f"STA {STA['b']}")
    ids_omitted = (sae_join_has_no_id(joined_a, sta_a, STA["a"])
                   and sae_join_has_no_id(joined_b, sta_b, STA["b"]))
    ports_open = authorized("a") and authorized("b")
    sae_config(bound_first, second)
    psk_reload, psk_reload_dropped_both = sae_reload(events, lambda: reload_psks(control), "a", "b")
    stop("a")
    stop("b")
    still_wildcard = bool(sae_joins(events, "b", FIRST, "first")) and authorized("b")
    a_rejoined = bool(sae_joins(events, "a", FIRST, "first")) and authorized("a")
    _, dropped_both = sae_reload(events, lambda: WORKERS["ap"].send_signal(signal.SIGHUP), "a", "b")
    stop("a")
    stop("b")
    # A fresh supplicant with PMKSA caching disabled on the AP exercises SAE again.
    bound = sae_denied("b", FIRST, "first")
    recovered = bool(sae_joins(events, "a", FIRST, "first")) and authorized("a")
    sae_config(second)
    _, revoked = sae_reload(events, lambda: WORKERS["ap"].send_signal(signal.SIGHUP), "a")
    expired = revoked and sae_denied("a", FIRST, "first")
    surviving = bool(sae_joins(events, "b", SECOND, "second")) and authorized("b")
    staged = set_sae_passwords(control, first, second)
    stage_denied = sae_denied("a", FIRST, "first")
    peer_survived_set = authorized("b")
    activated, interrupted = sae_reload(events, lambda: reload_psks(control), "b")
    changed = bool(sae_joins(events, "a", FIRST, "first")) and authorized("a")
    print(f"SAE SET_password_list_ok={staged} new_H2E_join_denied_before_reload={stage_denied} "
          f"peer_survived_SET={peer_survived_set} activation_disconnects_peer={bool(interrupted)} "
          f"new_H2E_join_after_activation={changed}")
    report(8, missing_id and joined_a and joined_b and ports_open and ids_omitted
           and psk_reload and psk_reload_dropped_both and still_wildcard
           and a_rejoined and dropped_both and bound and recovered and expired and surviving
           and staged and stage_denied and peer_survived_set and activated and interrupted and changed,
           f"missing_id_rejected={bool(missing_id)} two_ids_joined={bool(joined_a and joined_b and ports_open)} "
           f"both_STA_replies_authorized_and_ids_omitted={ids_omitted} reload_wpa_psk={psk_reload} "
           f"psk_reload_disconnected_both={psk_reload_dropped_both} disk_edit_ignored={still_wildcard} "
           f"SIGHUP_disconnected_both={dropped_both} "
           f"full_reload_mac_binding={bool(bound and recovered)} removed_id_revoked_and_rejected={bool(expired)} "
           f"other_id_joins={surviving}")
    events.close()
    control.close()


def main():
    product = Path("/sys/class/dmi/id/product_name")
    options = dict(item.split("=", 1) for item in Path("/proc/cmdline").read_text().split() if "=" in item)
    if (os.getpid() != 1 or not product.exists() or product.read_text().strip() != "hostapd-hwsim"
            or options.get("hostapd_hwsim.kernel") != os.uname().release):
        raise SystemExit("This test requires the launcher-created QEMU guest and matching kernel")
    try:
        print(f"KERNEL {os.uname().release}")
        print(run("hostapd", "-v", check=False))
        print(run("wpa_supplicant", "-v"))
        radios()
        wpa2(int(options["hostapd_hwsim.expiry"]))
        wpa3()
    except (OSError, RuntimeError, subprocess.SubprocessError, ValueError):
        traceback.print_exc()
    finally:
        for step in range(1, 9):
            if step not in RESULTS:
                print(f"BLOCKED {step} prerequisite or harness failed")
        passed = len(RESULTS) == 8 and all(RESULTS.values())
        if not passed:
            for name in ("ap", "a", "b", "dhcp"):
                if Path(f"/run/{name}.log").exists():
                    print(f"--- {name} ---\n" + "\n".join(log(name).splitlines()[-80:]))
        print("TIMING event_to_screen=not_measured (no CeraUI hostapd event reader)")
        print(f"RESULT: {'PASS' if passed else 'FAIL'}")
        os.execv("/usr/bin/busybox", ["busybox", "poweroff", "-f"])


if __name__ == "__main__":
    main()
