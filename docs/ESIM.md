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

Provision the runtime and helper separately using [Native lpac runtime](LPAC.md) and [eSIM host helper](ESIM-HELPER.md). Those documents own the native build, installation paths, private modem/card mapping and helper protocol. Test the helper before enabling the CeraUI feature:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/esim/tests -v
```

The helper verifies modem identity, port topology and the expected card before accessing profiles. Its snapshot binds each write to the current profile state. Writes run once, with bounded readback retries. Serial settings and modem inhibition are released before returning.

Every operation, including inspection, holds the existing streaming/modem interlock and a durable `esim` journal entry. Interrupted or uncertain operations retain a recovery block. USB descriptor equality cannot verify an eUICC rollback, so verified-rollback acknowledgement is refused for this journal kind. Inspect card/profile state separately before explicitly accepting a new baseline. Automatic rollback of profile downloads or deletions is unavailable.

The helper and private mapping are separate opt-in host provisioning. Development artifacts include the helper and source recipe for review. Hardware installation, sustained operation and complete image integration require additional qualification.

## Development delivery

[Generic fork builds](FORK-BUILDS.md) own application checks, the development container, architecture-specific archives and checksums. The eSIM integration adds the helper, source recipe and these instructions to the application payload. It does not install the root-owned helper, runtime or private device mapping automatically.

The standalone Native lpac runtime workflow exports native amd64/ARM64 prefixes. The eSIM host helper workflow tests its hardware-free protocol and cleanup behavior. Their checks and artifacts remain independent of the application workflow.

English and es-419 operator instructions are paired in this tree for the experimental change. Website publication belongs to the coordinated feature release. Other locale catalogs currently use English fallback copy for these new keys.
