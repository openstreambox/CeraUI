"""Boot the running kernel in a disposable QEMU guest for hostapd tests."""

import argparse
import gzip
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import sysconfig
import tempfile


def output(*command):
    return subprocess.check_output(command, text=True)


def required(name):
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"Missing executable: {name}")
    return Path(path)


def copy(root, source, destination=None):
    path = root / str(destination or source).lstrip("/")
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, path)


def copy_libraries(root, binary):
    probe = subprocess.run(["ldd", binary], capture_output=True, text=True)
    if "not a dynamic executable" in probe.stderr or "statically linked" in probe.stdout:
        return
    probe.check_returncode()
    libraries = probe.stdout
    if "not found" in libraries:
        raise RuntimeError(f"Missing dependencies for {binary}:\n{libraries}")
    for path in re.findall(r"^\s*(?:\S+\s+=>\s+)?(/\S+)\s+\(", libraries, re.M):
        copy(root, path)


def make_initramfs(root, archive, release, hostapd_dir):
    root.mkdir()
    for directory in ("dev", "proc", "sys", "run", "tmp", "etc"):
        (root / directory).mkdir()
    (root / "etc/passwd").write_text("root:x:0:0:root:/:/bin/sh\n")
    (root / "etc/group").write_text("root:x:0:\n")
    for name in (
        "busybox", "kmod", "ip", "iw", "ping", "dnsmasq", "wpa_supplicant",
        "hostapd",
    ):
        binary = hostapd_dir / name if name == "hostapd" and hostapd_dir else required(name)
        copy(root, binary, f"/usr/bin/{name}")
        copy_libraries(root, binary)
    for name in ("sh", "modprobe"):
        (root / f"usr/bin/{name}").symlink_to("busybox" if name == "sh" else "kmod")
    (root / "bin").symlink_to("usr/bin")
    (root / "sbin").symlink_to("usr/bin")
    python = Path(sys.executable)
    copy(root, python)
    copy_libraries(root, python)
    stdlib = Path(sysconfig.get_path("stdlib"))
    shutil.copytree(stdlib, root / str(stdlib).lstrip("/"), ignore=shutil.ignore_patterns(
        "__pycache__", "site-packages", "dist-packages", "config-*",
    ))
    for extension in stdlib.glob("lib-dynload/*.so"):
        copy_libraries(root, extension)
    modules = Path(f"/lib/modules/{release}")
    for path in modules.glob("modules.*"):
        copy(root, path)
    dependencies = output(required("modprobe"), "--show-depends", "mac80211_hwsim")
    if not re.search(r"^insmod .*?/mac80211_hwsim\.ko", dependencies, re.M):
        raise RuntimeError("The running kernel must supply mac80211_hwsim as a module")
    for cipher in ("crypto-ccm", "crypto-cmac"):
        dependencies += output(required("modprobe"), "--show-depends", cipher)
    for path in re.findall(r"^insmod (\S+)", dependencies, re.M):
        copy(root, path)
    for path in Path("/lib/firmware").glob("regulatory.db*"):
        copy(root, path)
    copy(root, Path(__file__).with_name("hostapd-scenarios.py"), "/scenarios.py")
    init = root / "init"
    init.write_text(
        "#!/bin/sh\n"
        "set -eu\n"
        "export PATH=/usr/bin\n"
        "export LC_ALL=C\n"
        "busybox mount -t proc proc /proc\n"
        "busybox mount -t sysfs sysfs /sys\n"
        "busybox mount -t devtmpfs devtmpfs /dev\n"
        f"exec {python} -I -u /scenarios.py\n"
    )
    init.chmod(0o755)
    paths = b"".join(os.fsencode(path.relative_to(root)) + b"\0" for path in sorted(root.rglob("*")))
    with tempfile.TemporaryFile() as raw:
        subprocess.run(["cpio", "--null", "-o", "-H", "newc", "--quiet"],
                       cwd=root, input=paths, stdout=raw, check=True)
        raw.seek(0)
        with gzip.open(archive, "wb", compresslevel=1) as compressed:
            shutil.copyfileobj(raw, compressed)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kernel", type=Path, help="readable copy of the running kernel image")
    parser.add_argument("--hostapd-dir", type=Path, help="directory containing an unpacked hostapd binary")
    parser.add_argument("--expiry-seconds", type=int, default=120, choices=range(1, 121), metavar="1..120")
    args = parser.parse_args()
    if os.uname().machine != "x86_64" or not os.access("/dev/kvm", os.R_OK | os.W_OK):
        parser.error("x86-64 Linux with read/write access to /dev/kvm is required")
    release = os.uname().release
    kernel = args.kernel or Path(f"/boot/vmlinuz-{release}")
    if not os.access(kernel, os.R_OK):
        parser.error(f"Kernel image is unreadable: {kernel}. Use --kernel with a readable copy.")
    qemu = required("qemu-system-x86_64")
    with tempfile.TemporaryDirectory(prefix="hostapd-hwsim-") as scratch:
        scratch = Path(scratch)
        archive = scratch / "initramfs.gz"
        make_initramfs(scratch / "root", archive, release, args.hostapd_dir)
        command = [
            qemu, "-machine", "q35,accel=kvm", "-cpu", "host", "-smp", "2", "-m", "768",
            "-nodefaults", "-nic", "none", "-display", "none", "-monitor", "none",
            "-serial", "stdio", "-no-reboot", "-kernel", str(kernel),
            "-initrd", str(archive), "-smbios", "type=1,product=hostapd-hwsim",
            "-append", (
                f"console=ttyS0 quiet loglevel=3 panic=1 rootfstype=ramfs hostapd_hwsim.kernel={release} "
                f"hostapd_hwsim.expiry={args.expiry_seconds}"
            ),
        ]
        # Inherit stderr for QEMU diagnostics. A guest poweroff alone has no test exit status.
        with subprocess.Popen(command, stdout=subprocess.PIPE, text=True) as vm:
            try:
                log, _ = vm.communicate(timeout=args.expiry_seconds + 150)
            except subprocess.TimeoutExpired:
                vm.kill()
                log, _ = vm.communicate()
                print(log, end="")
                raise RuntimeError("QEMU exceeded the test deadline") from None
        print(log, end="")
        return 0 if vm.returncode == 0 and "RESULT: PASS" in log.splitlines() else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
