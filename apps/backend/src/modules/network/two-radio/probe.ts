import { run } from "../../../helpers/run.ts";
import type { Runner } from "./native-owner.ts";

// One socket for issue/challenge/response. Peer filtering, binding readback and
// receiver-issued nonce are mandatory. Invalid echoes cannot establish proof.
const source = String.raw`
use strict; use warnings; use Socket; use JSON::PP;
my ($dev,$host,$port,$request)=@ARGV;
my $nonce=""; my $bound="";
$SIG{ALRM}=sub { if ($nonce =~ /^[a-f0-9]{48}$/) { print encode_json({nonce=>$nonce,bound=>$bound,ok=>JSON::PP::false})."\n"; exit 0; } die "deadline" }; alarm 2;
socket(my $s,PF_INET,SOCK_DGRAM,0) or die "socket";
setsockopt($s,SOL_SOCKET,25,$dev."\0") or die "bind device";
$bound=getsockopt($s,SOL_SOCKET,25); $bound =~ s/\0+$//;
die "binding readback" unless $bound eq $dev;
connect($s,sockaddr_in($port,inet_aton($host))) or die "connect";
send($s,"ISSUE $request",0) or die "issue";
recv($s,$nonce,512,0) or die "nonce";
die "invalid nonce" unless $nonce =~ /^[a-f0-9]{48}$/;
print encode_json({nonce=>$nonce,bound=>$bound})."\n";
$|=1;
send($s,"PROBE $nonce",0) or die "probe";
recv($s,my $response,512,0) or die "response";
die "invalid response" unless $response eq "ACK $nonce";
print encode_json({nonce=>$nonce,bound=>$bound,ok=>JSON::PP::true})."\n";
`;
export type ProbeResult = { nonce: string; socket: string; ok: boolean };
export async function boundProbe(
	ifname: string,
	target: string,
	port: number,
	signal: AbortSignal,
	runner: Runner = run,
): Promise<ProbeResult | null> {
	const socket = crypto.randomUUID();
	try {
		const output = await runner(
			"perl",
			["-e", source, "--", ifname, target, String(port), socket],
			{ signal, timeout: 2500, maxBuffer: 4096 },
		);
		const rows = output
			.trim()
			.split("\n")
			.map((x) => JSON.parse(x));
		const first = rows[0],
			last = rows[1];
		if (
			rows.length !== 2 ||
			first.bound !== ifname ||
			last.bound !== ifname ||
			first.nonce !== last.nonce ||
			!/^[a-f0-9]{48}$/.test(first.nonce) ||
			typeof last.ok !== "boolean"
		)
			throw new Error("Unattested response");
		return { nonce: first.nonce, socket, ok: last.ok };
	} catch {
		signal.throwIfAborted();
		return null;
	}
}
