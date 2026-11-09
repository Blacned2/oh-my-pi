import { type } from "@oh-my-pi/omptype";

const nodeSchema = type({
	id: /^[a-z][a-z0-9_-]{0,63}$/,
	role: "'planner' | 'context' | 'coder' | 'tester' | 'reviewer' | 'gate'",
	dependsOn: "string[]",
	maxAttempts: "1 <= number.integer <= 5",
});

const planSchema = type({ version: "1", nodes: nodeSchema.array().atLeastLength(1).atMostLength(64) });

export type GraphNode = typeof nodeSchema.infer;
export type GraphPlan = typeof planSchema.infer;

/** Validate the graph at the admission boundary and put prerequisites first. */
export function parseGraphPlan(input: unknown): GraphPlan {
	const plan = planSchema.assert(input);
	const nodes = new Map(plan.nodes.map(node => [node.id, node]));
	if (nodes.size !== plan.nodes.length) throw new Error("Graph has duplicate node IDs");
	for (const node of plan.nodes) {
		if (new Set(node.dependsOn).size !== node.dependsOn.length) {
			throw new Error(`Graph node ${node.id} has duplicate dependencies`);
		}
		for (const dependency of node.dependsOn) {
			if (!nodes.has(dependency)) throw new Error(`Graph node ${node.id} has an unknown dependency`);
		}
	}
	const ordered: GraphNode[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (node: GraphNode): void => {
		if (visited.has(node.id)) return;
		if (visiting.has(node.id)) throw new Error("Graph dependencies contain a cycle");
		visiting.add(node.id);
		for (const dependency of node.dependsOn) visit(nodes.get(dependency)!);
		visiting.delete(node.id);
		visited.add(node.id);
		ordered.push(node);
	};
	for (const node of plan.nodes) visit(node);
	return { version: plan.version, nodes: ordered };
}
