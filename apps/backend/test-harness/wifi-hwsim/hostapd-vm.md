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
| 4 | MAC binding via `RELOAD_WPA_PSK`, uninterrupted authorization and a ping train spanning the reload |
| 5 | A second station receives a PSK mismatch and never authorizes with the bound PSK |
| 6 | An unused entry expires, the existing station keeps its ping train, and the second station receives a PSK mismatch for the expired entry |
| 7 | Removing the bound entry deauthorizes the first station within 1 second |
| 8 | WPA3 SAE password identifiers, client identifier requirement, event and `STA` visibility, and the effect of PSK-only versus full reload on binding and removal |

Step 8 checks the behavior observed on hostapd 2.11. SAE with H2E can
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
