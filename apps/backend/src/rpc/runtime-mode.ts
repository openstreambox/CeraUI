/** Read the launch environment independently of the bundler's literal gates. */
export function runtimeAllowsDevelopment(): boolean {
	return Reflect.get(process.env, "NODE_ENV") !== "production";
}
