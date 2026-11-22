# Hostapd credential rotation in QEMU

Run from this directory on x86-64 Linux with KVM access. The launcher boots
the running host kernel in QEMU with an in-memory filesystem, no disks, no
network adapter and no passthrough devices. The guest starts one AP and two
stations on simulated radios in separate network namespaces. The launcher
reads the running kernel's module files to pack the guest image. All module
loads and network changes take place inside the guest.

On Ubuntu, the launcher uses the distribution Python 3, GNU cpio,
`qemu-system-x86`, kmod, the running kernel's modules including
`mac80211_hwsim` and its crypto dependencies, plus `busybox` with the
`udhcpc` applet, `iproute2`, `iputils-ping`, `iw`, `dnsmasq-base`,
`hostapd` and `wpasupplicant`. Install those tools or use an unpacked
hostapd package and supply its binary directory with `--hostapd-dir`. The
binaries and their shared libraries are copied into the guest. The guest
starts its own services. Use `--kernel` to supply a readable copy of the running
kernel image if the default `/boot/vmlinuz-$(uname -r)` is root-readable only.

```sh
/usr/bin/python3 hostapd-vm.py
```

The default expiry wait is 120 seconds. For iteration use
`--expiry-seconds 2`. The guest reports the kernel and both daemon versions,
each check's result, and its measured timings. The launcher exits nonzero
if a check fails, a prerequisite blocks a check, or QEMU fails to produce a
passing result.

| Step | Evidence |
| --- | --- |
| 1 | Three simulated radios, each moved to its own network namespace |
| 2 | WPA2 authorization and a dnsmasq lease for station A |
| 3 | The issued `keyid` in both the hostapd connection event and the `STA` query, plus at most 100 ms from hostapd's association log to control socket receipt |
| 4 | MAC binding via `RELOAD_WPA_PSK`, no connection transitions, and a 30-ping train started before reload. An independent probe sends a new request after the reload reply |
| 5 | A second station receives a PSK mismatch and never authorizes with the bound PSK |
| 6 | The running AP reports the exact unused PSK before expiry. A separate credential from the same reload authorizes the second station. The unused entry is removed within 250 ms after its deadline. The first station passes the same traffic checks as step 4 and the second station receives a PSK mismatch for the expired entry |
| 7 | Both stations start authorized. A kernel-timestamped disconnect for the first station arrives within 1 second of the reload. The second stays authorized and emits no connection transition during the observation window |
| 8 | Both successful WPA3 SAE joins and both authorized `STA` replies are checked for identifiers. Peer-specific rejections and kernel-timestamped disconnects are checked against the attempts and reloads that produced them. Station B's authorization and transition history are checked across the in-memory `SET` operations |

For the expiry readback, the test puts the unused credential at the head of
hostapd's active PSK list and compares the reported value with the expected
derived PSK. On the tested build, `GET_CONFIG` exposes that value when the
runtime WPS state is nonzero. The isolated AP starts with WPS disabled. The
harness toggles the runtime state for this query and restores it immediately.
The readback needs no association using the unused credential.

Step 8 checks the behavior observed on Ubuntu's hostapd build `2:2.11-0ubuntu5`. SAE with H2E can
authenticate two passwords when clients supply their corresponding identifiers.
The control event and station query omit the identifier. Sending
`RELOAD_WPA_PSK` after editing the AP config leaves the old SAE entries active
and disconnects both associated SAE stations. SIGHUP applies the binding and
removal from disk and also disconnects existing stations. The in-memory
`SET` path can replace the list, but on this build it needs
`RELOAD_WPA_PSK` to prepare the H2E password elements, which disconnects the
existing SAE station.

The timing samples cover the guest's hostapd control interface. Phone QR
parsing, physical radios, and CeraUI event delivery through to the screen
require separate tests.

Run the evidence regression tests on x86-64 Linux without QEMU or elevated privileges.

```sh
python3 -B -m unittest -v test_hostapd_scenarios.py
```
