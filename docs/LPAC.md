# Native lpac runtime

This standalone recipe builds [lpac](https://github.com/estkme-group/lpac) at commit `a43e46aef6f8b5b1d144bf3b3fc5999d8fcefacc`. It has no dependency on the CeraUI application or its eSIM management interface.

From the repository root:

```sh
docker build --file scripts/esim/Dockerfile --output type=local,dest=dist/esim-runtime .
```

The build runs the pinned source's CTest suites, installs the result at its intended prefix inside the build container and executes an installed-prefix smoke test. The exported `lpac/` directory contains the executable, drivers, pinned source revision, applied patches and upstream/component license notices. Install that directory as `/usr/libexec/ceralive/lpac` only after reviewing the target host's provisioning requirements. The build exports files; it does not configure or access host modems.

Three patches support this runtime:

- Uppercase hexadecimal APDUs for AT/CSIM firmware that requires uppercase input.
- Activation and confirmation codes from stdin using `profile download -a -` and optional `-c -`. Supply the activation code on the first line and the confirmation code on the second, keeping secrets out of process arguments.
- An installed-prefix library search path for the dynamically loaded drivers.

The recipe enables explicitly selected AT and AT/CSIM transports, disables PC/SC, QMI and MBIM, and uses libcurl for HTTPS. The AT implementation has [documented response-time limitations](https://github.com/estkme-group/lpac/blob/a43e46aef6f8b5b1d144bf3b3fc5999d8fcefacc/docs/backends/at.md). Qualify each modem firmware, adapter and eUICC combination before profile operations.

The Native lpac runtime workflow builds on native amd64 and ARM64 runners and uploads each prefix independently. A local build uses the host builder's architecture; an amd64 build is not an ARM64 qualification. CeraUI application archives and their quality gates are documented separately in [Fork builds](FORK-BUILDS.md).
