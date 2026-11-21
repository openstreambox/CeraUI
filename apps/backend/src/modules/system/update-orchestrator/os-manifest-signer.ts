/**
 * Who may sign OS channel metadata (channel manifests and kernel sidecars).
 *
 * The CMS chain is anchored in the device keyring first; these identities are
 * the second check on top of it. Each signer name is bound to the one
 * intermediate allowed to issue it, so a certificate that chains to a trusted
 * root still needs the right name, issuer and purpose.
 */
export type ManifestSigner = {
	readonly cn: string;
	readonly eku: readonly string[];
	readonly issuer: string;
};

export type ManifestSignerIdentity = {
	readonly cn: string;
	readonly issuer: string;
};

export const MANIFEST_SIGNER_IDENTITIES: readonly ManifestSignerIdentity[] = [
	// CeraLive production and persistent bench release chains.
	{
		cn: "CeraLive OTA Manifest Signer",
		issuer: "CN=CeraLive RAUC Intermediate CA,O=CeraLive",
	},
	{
		cn: "CeraLive OTA Manifest Signer",
		issuer: "CN=CeraLive RAUC Bench Intermediate CA,O=CeraLive",
	},
	// OpenStreamBox release chain for fork images that carry its root.
	{
		cn: "OpenStreamBox OTA Manifest Signer",
		issuer: "CN=OpenStreamBox Release Intermediate CA,O=OpenStreamBox",
	},
];

type ManifestSignerRefusal = {
	readonly ok: false;
	readonly reason: "signer_not_manifest_signer" | "signer_issuer_invalid";
};

/**
 * A known name with code signing only, then the issuer paired with that name.
 * The bundle-signing leaf carries emailProtection for RAUC and is refused here.
 */
export function manifestSignerRefusal(
	signer: ManifestSigner,
	identities: readonly ManifestSignerIdentity[] = MANIFEST_SIGNER_IDENTITIES,
): ManifestSignerRefusal | null {
	const named = identities.filter((identity) => identity.cn === signer.cn);
	if (
		named.length === 0 ||
		!signer.eku.includes("codeSigning") ||
		signer.eku.includes("emailProtection")
	)
		return { ok: false, reason: "signer_not_manifest_signer" };
	if (!named.some((identity) => identity.issuer === signer.issuer))
		return { ok: false, reason: "signer_issuer_invalid" };
	return null;
}
