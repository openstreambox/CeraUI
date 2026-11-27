#!/usr/bin/env bun
if (process.argv[2] !== "--capabilities-json") process.exit(2);
process.stdout.write(
	JSON.stringify({
		capabilities: {
			bind_map: true,
			bind_map_schema_version: 1,
			bind_map_required: true,
			bind_map_required_empty_reload: true,
			bind_map_contract: 2,
		},
	}),
);
process.stdout.write("\n");
