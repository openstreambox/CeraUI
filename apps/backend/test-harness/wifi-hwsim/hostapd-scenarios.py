"""Guest init and hostapd hotspot credential checks."""

import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import time
import traceback


AP = "192.0.2.1"
STA = {"a": "02:00:00:00:00:0a", "b": "02:00:00:00:00:0b"}
WILDCARD = "00:00:00:00:00:00"
FIRST = "fixture-password-first"
SECOND = "fixture-password-second"
STANDING = "fixture-password-standing"
PSK_FILE = Path("/run/psks")
SAE_FILE = Path("/run/sae-passwords")
AP_CONFIG = Path("/run/hostapd.conf")
WORKERS = {}
RESULTS = {}


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

    def event(self, pattern, seconds=8):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.socket.settimeout(max(0.001, deadline - time.monotonic()))
            try:
                event = self.socket.recv(16384).decode().strip()
            except TimeoutError:
                break
            if re.search(pattern, event):
                return event, time.time(), time.monotonic()
        return "", 0, 0

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
    if not until(lambda: "state=ENABLED" in control.command("STATUS")) or events.command("ATTACH") != "OK":
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
    status = run("iw", "dev", "testwifi", "station", "get", STA[station_name],
                 namespace="ap", check=False)
    return bool(re.search(r"authorized:\s+yes", status))


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


def continuous_ping(name, mutation):
    process = launch(name, "a", "ping", "-n", "-i", "0.04", "-c", "30", "-W", "1", AP)
    if not until(lambda: "icmp_seq=" in log(name), 2):
        raise RuntimeError("Ping did not establish traffic before reload")
    reloaded = mutation()
    process.wait(timeout=5)
    result = re.search(r"(\d+) packets transmitted, (\d+) received", log(name))
    sent, received = map(int, result.groups()) if result else (0, 0)
    return reloaded and sent == received == 30 and authorized("a"), f"ping={received}/{sent}"


def denied_psk(events, secret, empty_candidates=False):
    offset = len(log("ap"))
    station("b", secret)
    if empty_candidates:
        denial = until(lambda: re.search(
            r"STA " + STA["b"] + r".*no PSK configured for the STA", log("ap")[offset:],
        ))
        evidence = "no PSK configured for B" if denial else "no missing-PSK diagnostic"
    else:
        denial, _, _ = events.event(r"AP-STA-POSSIBLE-PSK-MISMATCH\s+" + STA["b"])
        evidence = denial or "no PSK mismatch event"
    accepted = authorized("b") or "CTRL-EVENT-CONNECTED" in log("b")
    if not denial:
        print("\n".join(line for line in log("ap")[offset:].splitlines()
                        if any(word in line.lower() for word in ("psk", "reject", "status code")))[-3000:])
    stop("b")
    return bool(denial) and not accepted, evidence


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
    station("a", FIRST)
    joined, received, _ = events.event(r"AP-STA-CONNECTED\s+" + STA["a"])
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

    def bind():
        psks(bound)
        return reload_psks(control)

    clean, traffic = continuous_ping("binding-ping", bind)
    dropped, _, _ = events.event(r"AP-STA-DISCONNECTED\s+" + STA["a"], 0.15)
    report(4, clean and not dropped, f"{traffic} authorized={authorized('a')} disconnect_event={bool(dropped)}")
    no_candidate, no_candidate_evidence = denied_psk(events, FIRST, empty_candidates=True)
    psks(bound, standing)
    active = reload_psks(control)
    mismatch, mismatch_evidence = denied_psk(events, FIRST)
    report(5, active and no_candidate and mismatch,
           f"B denied with and without another eligible PSK: {no_candidate_evidence}; {mismatch_evidence}")

    psks(bound, standing, unused)
    armed = reload_psks(control)
    started = time.monotonic()
    deadline = started + expiry_seconds
    time.sleep(max(0, deadline - time.monotonic() - 0.25))

    def expire():
        time.sleep(max(0, deadline - time.monotonic()))
        psks(bound, standing)
        reloaded = reload_psks(control)
        print(f"TIMING issue_to_expiry_reload_ms={(time.monotonic() - started) * 1000:.3f}")
        return reloaded

    clean, traffic = continuous_ping("expiry-ping", expire)
    dropped, _, _ = events.event(r"AP-STA-DISCONNECTED\s+" + STA["a"], 0.15)
    denied, evidence = denied_psk(events, SECOND)
    report(6, armed and clean and not dropped and denied,
           f"unused fixture expired after {expiry_seconds}s; {traffic} disconnect_event={bool(dropped)} B={evidence}")

    station("b", STANDING)
    peer, _, _ = events.event(r"AP-STA-CONNECTED\s+" + STA["b"])
    psks(standing)
    started = time.monotonic()
    reloaded = reload_psks(control)
    disconnected, _, observed = events.event(r"AP-STA-DISCONNECTED\s+" + STA["a"], 1)
    elapsed = (observed - started) * 1000 if disconnected else float("inf")
    a_authorized, b_authorized = authorized("a"), authorized("b")
    report(7, reloaded and elapsed <= 1000 and not a_authorized and peer and b_authorized,
           f"reload_to_disconnect_ms={elapsed:.3f} A_authorized={a_authorized} B_authorized={b_authorized}")
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
    station(name, secret, sae=True, identifier=identifier)
    return events.event(r"AP-STA-CONNECTED\s+" + STA[name])[0]


def sae_denied(name, secret, identifier=None):
    offset = len(log("ap"))
    station(name, secret, sae=True, identifier=identifier)

    def rejected():
        return ("CTRL-EVENT-AUTH-REJECT" in log(name)
                or "SAE: No password available" in log("ap")[offset:])

    until(lambda: rejected() or authorized(name), 6)
    denied = rejected() and not authorized(name) and "CTRL-EVENT-CONNECTED" not in log(name)
    if not denied:
        print("\n".join(line for line in log("ap")[offset:].splitlines()
                        if any(word in line for word in ("SAE:", "authentication")))[-3000:])
    stop(name)
    return denied


def both_disconnected(events):
    disconnects = set()
    for _ in STA:
        event, _, _ = events.event(r"AP-STA-DISCONNECTED\s+\S+", 2)
        if event:
            disconnects.add(event.split()[-1])
    return disconnects == set(STA.values())


def wpa3():
    first = f"{FIRST}|id=first"
    second = f"{SECOND}|id=second"
    bound_first = f"{FIRST}|mac={STA['a']}|id=first"
    sae_config(first, second)
    control, events = start_ap()
    missing_id = sae_denied("a", FIRST)
    joined_a = sae_joins(events, "a", FIRST, "first")
    field = re.search(r"^(?:keyid|sae_password_id)=.*", control.command(f"STA {STA['a']}"), re.M)
    joined_b = sae_joins(events, "b", SECOND, "second")
    ports_open = authorized("a") and authorized("b")
    sae_config(bound_first, second)
    psk_reload = control.command("RELOAD_WPA_PSK")
    psk_reload_dropped_both = both_disconnected(events)
    stop("a")
    stop("b")
    still_wildcard = bool(sae_joins(events, "b", FIRST, "first")) and authorized("b")
    a_rejoined = bool(sae_joins(events, "a", FIRST, "first")) and authorized("a")
    WORKERS["ap"].send_signal(signal.SIGHUP)
    dropped_both = both_disconnected(events)
    stop("a")
    stop("b")
    # A fresh supplicant with PMKSA caching disabled on the AP exercises SAE again.
    bound = sae_denied("b", FIRST, "first")
    recovered = bool(sae_joins(events, "a", FIRST, "first")) and authorized("a")
    sae_config(second)
    WORKERS["ap"].send_signal(signal.SIGHUP)
    revoked, _, _ = events.event(r"AP-STA-DISCONNECTED\s+" + STA["a"], 2)
    expired = bool(revoked) and sae_denied("a", FIRST, "first")
    surviving = bool(sae_joins(events, "b", SECOND, "second")) and authorized("b")
    staged = set_sae_passwords(control, first, second)
    stage_denied = sae_denied("a", FIRST, "first")
    peer_survived_set = authorized("b")
    activated = reload_psks(control)
    interrupted, _, _ = events.event(r"AP-STA-DISCONNECTED\s+" + STA["b"], 2)
    changed = bool(sae_joins(events, "a", FIRST, "first")) and authorized("a")
    print(f"SAE SET_password_list_ok={staged} new_H2E_join_denied_before_reload={stage_denied} "
          f"peer_survived_SET={peer_survived_set} activation_disconnects_peer={bool(interrupted)} "
          f"new_H2E_join_after_activation={changed}")
    reports_id = "keyid=" in joined_a or "sae_password_id=" in joined_a or bool(field)
    report(8, missing_id and joined_a and joined_b and ports_open and not reports_id
           and psk_reload == "OK" and psk_reload_dropped_both and still_wildcard
           and a_rejoined and dropped_both and bound and recovered and expired and surviving
           and staged and stage_denied and peer_survived_set and activated and interrupted and changed,
           f"missing_id_rejected={bool(missing_id)} two_ids_joined={bool(joined_a and joined_b and ports_open)} "
           f"id_reported={reports_id} reload_wpa_psk={psk_reload} "
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
