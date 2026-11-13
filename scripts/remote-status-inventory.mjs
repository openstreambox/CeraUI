import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import ts from 'typescript';

const configPath = ts.findConfigFile('apps/backend', ts.sys.fileExists);
const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, 'apps/backend');
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const inventory = [];
const dependencies = new Set();
function fields(type, prefix = '', depth = 0, seen = new Set()) {
	if (!type || depth > 10 || seen.has(type)) return [{ path: prefix, type: 'opaque' }];
	const next = new Set(seen).add(type);
	if (type.isUnion()) return type.types.flatMap((t) => fields(t, prefix, depth, next));
	if (checker.isArrayType(type))
		return fields(
			checker.getIndexTypeOfType(type, ts.IndexKind.Number),
			`${prefix}[]`,
			depth + 1,
			next,
		);
	if (
		type.flags &
		(ts.TypeFlags.StringLike |
			ts.TypeFlags.NumberLike |
			ts.TypeFlags.BooleanLike |
			ts.TypeFlags.Null |
			ts.TypeFlags.Undefined |
			ts.TypeFlags.Unknown |
			ts.TypeFlags.Any)
	)
		return [{ path: prefix, type: checker.typeToString(type) }];
	const out = [];
	for (const property of type.getProperties()) {
		const d = property.valueDeclaration ?? property.declarations?.[0];
		if (!d) continue;
		const file = relative(process.cwd(), d.getSourceFile().fileName);
		if (file.startsWith('apps/') || file.startsWith('packages/')) dependencies.add(file);
		out.push(
			...fields(
				checker.getTypeOfSymbolAtLocation(property, d),
				prefix ? `${prefix}.${property.name}` : property.name,
				depth + 1,
				next,
			),
		);
	}
	const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
	if (index) out.push(...fields(index, `${prefix}.*`, depth + 1, next));
	return out.length ? out : [{ path: prefix, type: checker.typeToString(type) }];
}
for (const source of program.getSourceFiles()) {
	const sourceName = relative(process.cwd(), source.fileName);
	if (
		!sourceName.startsWith('apps/backend/src/') ||
		sourceName.includes('/tests/') ||
		sourceName.includes('.test.')
	)
		continue;
	function walk(n) {
		if (
			ts.isCallExpression(n) &&
			ts.isIdentifier(n.expression) &&
			['buildMsg', 'broadcastMsg', 'broadcastMsgExcept', 'broadcastMsgLocal'].includes(
				n.expression.text,
			)
		) {
			const offset = n.expression.text === 'broadcastMsgExcept' ? 1 : 0;
			const name = n.arguments[offset];
			const payload = n.arguments[offset + 1];
			if (name && payload) {
				dependencies.add(sourceName);
				inventory.push({
					source: sourceName,
					call: n.expression.text,
					message: checker.typeToString(checker.getTypeAtLocation(name)),
					fields: fields(checker.getTypeAtLocation(payload)),
				});
			}
		}
		ts.forEachChild(n, walk);
	}
	walk(source);
}
function decision(message, path) {
	const m = message.replaceAll('"', '');
	const scalar = {
		config: [
			'max_br',
			'srt_latency',
			'delay',
			'bitrate_overlay',
			'fec_enabled',
			'autostart',
			'dhcp',
			'roaming',
			'slot',
			'bands[]',
		],
		status: [
			'is_streaming',
			'stream_lifecycle',
			'cellular_initializing',
			'set_password',
			'engine_bitrate.applied_kbps',
			'engine_bitrate.ceiling_kbps',
			'buffering.active',
			'buffering.spooled_bytes',
			'buffering.data_headroom_bytes',
			'buffering.disk_warning',
			'linkTelemetry.measured_bps',
			'linkTelemetry.bytes_sent_total',
			'linkTelemetry.lastReadMs',
		],
		'device-stats': ['cpuLoad1', 'socTemp', 'memTotalBytes', 'memAvailableBytes'],
		'device.activeProfile': [
			'config.presetId',
			'config.latencyMs',
			'config.fecEnabled',
			'config.recoveryMode',
		],
	};
	if (scalar[m]?.includes(path)) return 'needed: typed scalar or closed enum';
	if (
		(m === 'netif' && /\.\*\.(tp|tx_bps|rx_bps|enabled)$/.test(path)) ||
		(m === 'status' &&
			/linkTelemetry.links\[\]\.(rtt_ms|nak_count|weight_percent|bitrate_bps|bytes_sent_total|stale)$/.test(
				path,
			))
	)
		return 'needed: typed diagnostic';
	const surface =
		m === 'modems' || m === 'netif'
			? m
			: m === 'status' && path.startsWith('wifi.')
				? 'wifi'
				: m === 'status' && path.startsWith('modems.')
					? 'modems'
					: undefined;
	const leaf = path.replace(/^(wifi|modems)\./, '').replace(/^(\.\*)?\*?\.?/, '');
	if (
		surface === 'modems' &&
		['status.signal', 'status.roaming', 'status.connection', 'status.network_type'].includes(leaf)
	)
		return 'needed: typed modem diagnostic';
	if (
		surface === 'wifi' &&
		['mode', 'supports_hotspot', 'supports_ap_sta_concurrency', 'hotspot.max_width_mhz'].includes(
			leaf,
		)
	)
		return 'needed: typed radio state';
	if (surface && ['ifname', 'hw', 'name', 'conn'].includes(leaf))
		return 'distinction needed; original identity not needed: substitute neutral session label';
	if (surface === 'wifi' && leaf.startsWith('saved.'))
		return 'saved profile distinction needed; names and UUIDs not needed: substitute session labels';
	if (surface === 'wifi' && leaf === 'hotspot.name')
		return 'hotspot distinction needed; configured name not needed: fixed Hotspot label';
	if (surface)
		return 'not needed remotely: withhold local network identity, account or management detail';
	if (m === 'status' && /^linkTelemetry.links\[\]\.(id|iface)$/.test(path))
		return 'link distinction needed; original identity not needed: substitute session labels';
	return 'not needed for core remote start/stop, bitrate and link diagnosis: local only';
}
// Collapse union alternatives at each leaf, while keeping every call site.
for (const call of inventory) {
	const merged = new Map();
	for (const f of call.fields) {
		const item = merged.get(f.path) ?? {
			path: f.path,
			types: [],
			decision: decision(call.message, f.path),
		};
		if (!item.types.includes(f.type)) item.types.push(f.type);
		merged.set(f.path, item);
	}
	call.fields = [...merged.values()];
}
dependencies.add('bun.lock');
const result = {
	policy:
		'Default deny. Every source leaf has a decision below. Explicit typed DTO construction in remote-status.ts is the executable allowlist; see REMOTE-STATUS.md.',
	calls: inventory,
	dependencies: Object.fromEntries(
		[...dependencies]
			.sort()
			.map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]),
	),
};
writeFileSync(
	process.argv[2] ?? 'docs/remote-status-inventory.json',
	`${JSON.stringify(result, null, 2)}\n`,
);
