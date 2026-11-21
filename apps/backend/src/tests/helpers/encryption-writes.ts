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
	const bulk = (node: ts.Expression, descriptors = false) => {
		node = unwrap(node);
		// Copying existing config does not introduce new values.
		if (!descriptors && isConfig(node)) return;
		if (!ts.isObjectLiteralExpression(node)) {
			writes.push("<opaque config write>");
			return;
		}
		for (const property of node.properties) {
			if (ts.isSpreadAssignment(property))
				bulk(property.expression, descriptors);
			else {
				const key = ts.isIdentifier(property.name)
					? property.name.text
					: keyText(property.name);
				record(
					key,
					!descriptors && ts.isPropertyAssignment(property)
						? property.initializer.getText(source)
						: "<non-literal config write>",
				);
			}
		}
	};
	// Assignment patterns contain targets, but computed names and defaults
	// contain reads. Follow only the target side of each pattern element.
	const pattern = (node: ts.Expression) => {
		node = unwrap(node);
		const target = member(node);
		if (target) record(target.key, "<pattern write>");
		else if (isConfig(node)) writes.push("<opaque config write>");
		else if (ts.isObjectLiteralExpression(node)) {
			for (const property of node.properties) {
				if (ts.isPropertyAssignment(property)) pattern(property.initializer);
				else if (ts.isShorthandPropertyAssignment(property))
					pattern(property.name);
				else if (ts.isSpreadAssignment(property)) pattern(property.expression);
			}
		} else if (ts.isArrayLiteralExpression(node)) {
			for (const element of node.elements) {
				if (!ts.isOmittedExpression(element))
					pattern(ts.isSpreadElement(element) ? element.expression : element);
			}
		} else if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken
		)
			pattern(node.left);
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
			else pattern(node.left);
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
			(ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
			!ts.isVariableDeclarationList(node.initializer)
		)
			pattern(node.initializer);
		if (ts.isCallExpression(node)) {
			const callee = unwrap(node.expression);
			if (
				ts.isPropertyAccessExpression(callee) ||
				ts.isElementAccessExpression(callee)
			) {
				const owner = unwrap(callee.expression).getText(source);
				const method = ts.isPropertyAccessExpression(callee)
					? callee.name.text
					: keyText(callee.argumentExpression);
				const [target, key, value] = node.arguments;
				if (target && isConfig(target)) {
					if (owner === "Object" || owner === "globalThis.Object") {
						if (method === "assign")
							node.arguments.slice(1).forEach((source) => {
								bulk(source);
							});
						if (method === "defineProperty")
							record(key && keyText(key), "<define write>");
						// Descriptor maps use the same keys as the properties they write.
						if (method === "defineProperties") {
							if (key) bulk(key, true);
							else writes.push("<opaque config write>");
						}
					}
					if (
						(owner === "Reflect" || owner === "globalThis.Reflect") &&
						method === "defineProperty"
					)
						record(key && keyText(key), "<define write>");
					if (
						(owner === "Reflect" || owner === "globalThis.Reflect") &&
						method === "set"
					)
						record(
							key && keyText(key),
							value?.getText(source) ?? "<missing value>",
						);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(root);
	return writes;
}
