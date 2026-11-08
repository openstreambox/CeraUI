# eSIM management

Experimental consumer-eUICC management is available in Network → modem configuration → Advanced → eSIM profiles. Enable the eSIM module in Settings first. The host must have the helper, a reviewed modem/card mapping and the pinned lpac build described below.

## Obtaining a profile

Ask the provider for installation on the box's eUICC. Keep its QR code, full `LPA:1` activation string, or separate SM-DP+ address and matching ID. A confirmation code, sometimes called ePIN, may also be required. Provider account credentials authorize obtaining these details. SIM PIN and PUK belong to the existing SIM unlock screen.

Telekom exposes a manual-installation code in its app and a QR code in its customer portal. Vodafone documents email QR/ePIN delivery for CallYa and activation details in MeinVodafone. Airalo supports QR and manual installation alongside device-specific direct installation. Availability and reissue rules depend on the provider. Phone-to-phone transfer and account-bound app installation require a provider-supported route for the target eUICC. [Telekom](https://www.telekom.de/hilfe/mobilfunk/sim/esim-aktivieren) · [Vodafone](https://www.vodafone.de/hilfe/alles-zur-esim.html) · [Airalo installation API](https://developers.partners.airalo.com/get-installation-instructions-11883029e0)

The selected workflow supports QR photos/screenshots and pasted/manual activation details. Image decoding runs locally in the browser. Activation fields are masked, cleared after submission or close, and sent through authenticated RPC and helper stdin. The patched lpac reads activation and confirmation codes from stdin. Card identifiers, activation codes and downloaded profile payloads are excluded from replies, journal records and application logs.

## Using the modem screen

1. Stop streaming, disconnect this modem's data session and keep Ethernet, Wi-Fi or another modem available for internet access.
2. Open Manage eSIMs, acknowledge the temporary disconnection, then Read profiles. Reading also briefly inhibits modem management for exclusive card access.
3. Choose a QR photo/screenshot, paste a full LPA code, or select separate manual fields. Enter the provider's confirmation code when supplied. Confirm the download warning.
4. A successful download is verified through a new profile list and leaves the profile disabled. Select Enable separately and confirm the reconnection warning.
5. Check the APN, roaming, registration and data connection in the existing modem controls. Profile-state success establishes the card state. Carrier connectivity needs its own check.
6. Disable a profile before deleting it. Confirm the permanent deletion warning. Deletion may require a new activation code for reinstallation and leaves the provider contract in force.

Activation codes may be single-use. Plan validity can start at installation or first network use, according to provider terms. Keep QR codes private. A browser or helper timeout means the outcome needs investigation. Avoid repeating a download until the card has been inspected.

## Host integration

The initial build supports explicitly selected AT and AT/CSIM transports. The upstream AT implementation has documented response-time limitations. Each modem firmware, adapter and eUICC combination requires qualification. The host downloads the profile over another working internet path while APDUs pass through the selected modem. [lpac transports](https://github.com/estkme-group/lpac/blob/a43e46aef6f8b5b1d144bf3b3fc5999d8fcefacc/docs/ENVVARS.md) · [AT limits](https://github.com/estkme-group/lpac/blob/a43e46aef6f8b5b1d144bf3b3fc5999d8fcefacc/docs/backends/at.md)

Build the native lpac artifact in a container from the repository root. This runs the pinned source's tests and exports files only.

```sh
docker build --file scripts/esim/Dockerfile --output type=local,dest=dist/esim-runtime .
python3 -m unittest discover -s scripts/esim/tests -v
```

The exported lpac prefix targets `/usr/libexec/ceralive/lpac`. An administrator installs that directory and `apps/backend/ceralive-esim-helper` as `/usr/libexec/ceralive/esim-helper`, owned by root and mode 0750. The helper needs Python 3, ModemManager, udev and lpac's libcurl runtime dependencies. The container artifact is amd64 when built on an amd64 host. ARM64 needs a native ARM64 builder with the same recipe.

The root-owned `/etc/ceralive/esim-devices.json` maps CeraUI's physical `stable_key` to a reviewed device. Set mode 0600. Replace every placeholder using independently verified device facts. Keep this file outside source control.

```json
{
  "physical-topology-key": {
    "uid": "ModemManager generic.device value",
    "port": "/dev/ttyUSB0",
    "portIdPath": "udev ID_PATH of this serial port",
    "backend": "at_csim",
    "eid": "00000000000000000000000000000000"
  }
}
```

The helper checks the live ModemManager UID, refuses an active data session, verifies the port topology, acquires an inhibition and checks the expected EID before accessing profiles. A hash binds each operation to the exact card and profile-list state. Profile refresh permits three bounded read attempts. Writes and downloads execute once. Only notifications created by that operation are processed. The original serial configuration is restored and the inhibition child is reaped before returning.

Every operation, including inspection, holds the existing streaming/modem interlock and a durable `esim` journal entry. Interrupted or uncertain operations retain a recovery block. USB descriptor equality cannot verify an eUICC rollback, so verified-rollback acknowledgement is refused for this journal kind. Inspect card/profile state separately before explicitly accepting a new baseline. Automatic rollback of profile downloads or deletions is unavailable.

The helper and private mapping are separate opt-in host provisioning. Development artifacts include the helper and source recipe for review. Hardware installation, sustained operation and complete image integration require additional qualification.

## Local fork and delivery

Use exact Bun 1.4.3 and the frozen lockfile. The regular repository gates remain applicable.

```sh
bun install --frozen-lockfile
bun run lint
bun run test
bun run check:tech-debt
bun run test:release-package-contracts
BUILD_ARCH=amd64 bun run build
BUILD_ARCH=arm64 bun run build
```

For a local toolchain with packaging prerequisites, build `scripts/fork/Dockerfile`. Run it as its default unprivileged user with `--init`, a checkout bind mount at `/work`, and a 0022 umask. Namespace integration tests additionally require an isolated container with `SYS_ADMIN`, `NET_ADMIN` and an unconfined seccomp profile. Its passwordless sudo rule permits `unshare` inside that container. Keep host devices, host networking, credentials and the Docker socket outside it.

`BUILD_ARCH=amd64 scripts/fork/package.sh dist-artifacts/amd64` creates a development archive and checksum file in a new output directory. Use `arm64` for the second architecture. The provenance record marks uncommitted source as modified. Source maps are excluded from these payload archives.

The additional Fork development artifacts workflow runs on the integration branch or manual dispatch. It delivers checked application archives for amd64 and arm64, plus native amd64/arm64 lpac jobs and their notices. The native ARM64 lane uses `ubuntu-24.04-arm`. [GitHub runner availability](https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/) GitHub Actions uploads provide the development delivery channel. The normal production release path needs independently controlled federation-signing keys, object storage and package-index infrastructure.

A complete source-maintainable OS fork also needs source for the pinned streaming engine and control protocol. The image pipeline references `CERALIVE/cerastream`. Public ceracoder is a historical encoder with a different binding package. Record source availability separately from successful registry-based CeraUI builds. Signed images, OTA releases and physical-device tests each need their own receipts.

English and es-419 operator instructions are paired in this tree for the experimental change. Website publication belongs to the coordinated feature release. Other locale catalogs currently use English fallback copy for these new keys.
