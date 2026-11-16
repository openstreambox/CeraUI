import ts from "typescript";

// This is a syntax guard for the receiver handler, not whole-program alias
// analysis. Unknown computed keys and bulk sources may contain encryption fields,
// so writes through those forms require an explicit, inspectable key instead.
export function encryptionWrites(
	root: ts.Node,
	source: ts.SourceFile,
): string[] {
	const writes: string[] = [];
	const unwrap = (node: ts.Expression): ts.Expression => {
		while (
			ts.isParenthesizedExpression(node) ||
			ts.isAsExpression(node) ||
			ts.isNonNullExpression(node) ||
			ts.isSatisfiesExpression(node)
		)
			node = node.expression;
		return node;
	};
	const isConfig = (node: ts.Expression) => {
		const value = unwrap(node);
		return ts.isIdentifier(value) && value.text === "config";
	};
	const keyText = (node: ts.Node): string | undefined => {
		if (ts.isComputedPropertyName(node)) return keyText(node.expression);
		if (ts.isStringLiteralLike(node)) return node.text;
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.PlusToken
		) {
			const left = keyText(node.left);
			const right = keyText(node.right);
			return left !== undefined && right !== undefined
				? left + right
				: undefined;
		}
		return undefined;
	};
	const record = (key: string | undefined, value: string) => {
		// Generic stale-override cleanup already clears computed fields. It
		// cannot introduce a value, regardless of which key is selected.
		if (key === undefined && value === "undefined") return;
		if (key === undefined || key === "srt_passphrase" || key === "srt_pbkeylen")
			writes.push(key === undefined ? "<computed config write>" : value);
	};
	const member = (
		node: ts.Expression,
	): { key: string | undefined } | undefined => {
		node = unwrap(node);
		if (ts.isPropertyAccessExpression(node) && isConfig(node.expression))
			return { key: node.name.text };
		if (ts.isElementAccessExpression(node) && isConfig(node.expression))
			return { key: keyText(node.argumentExpression) };
		return undefined;
	};
	const bulk = (node: ts.Expression) => {
		node = unwrap(node);
		// Copying existing config does not introduce new values.
		if (isConfig(node)) return;
		if (!ts.isObjectLiteralExpression(node)) {
			writes.push("<opaque config write>");
			return;
		}
		for (const property of node.properties) {
			if (ts.isSpreadAssignment(property)) bulk(property.expression);
			else {
				const key = ts.isIdentifier(property.name)
					? property.name.text
					: keyText(property.name);
				record(
					key,
					ts.isPropertyAssignment(property)
						? property.initializer.getText(source)
						: "<non-literal config write>",
				);
			}
		}
	};
	const visit = (node: ts.Node) => {
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
			node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
		) {
			const target = member(node.left);
			if (target)
				record(
					target.key,
					node.operatorToken.kind === ts.SyntaxKind.EqualsToken
						? node.right.getText(source)
						: "<compound write>",
				);
			else if (isConfig(node.left)) bulk(node.right);
		}
		if (
			(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
			(node.operator === ts.SyntaxKind.PlusPlusToken ||
				node.operator === ts.SyntaxKind.MinusMinusToken)
		) {
			const target = member(node.operand);
			if (target) record(target.key, "<update write>");
		}
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression)
		) {
			const owner = node.expression.expression.getText(source);
			const method = node.expression.name.text;
			const [target, key, value] = node.arguments;
			if (target && isConfig(target)) {
				if (owner === "Object" && method === "assign")
					node.arguments.slice(1).forEach(bulk);
				if (owner === "Reflect" && method === "set")
					record(
						key && keyText(key),
						value?.getText(source) ?? "<missing value>",
					);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(root);
	return writes;
}
