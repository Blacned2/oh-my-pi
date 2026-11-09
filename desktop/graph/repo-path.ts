const invalidWindowsPath = /[<>:"\\|?*\x00-\x1f]/;
const deviceName = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/i;

/** Return each case-insensitive prefix so aliases of a directory are also detectable. */
export function repoPathPrefixes(file: string): [key: string, spelling: string][] {
	const prefixes: [string, string][] = [];
	let spelling = "";
	for (const part of file.split("/")) {
		if (
			!part ||
			invalidWindowsPath.test(part) ||
			/[. ]$/.test(part) ||
			deviceName.test(part) ||
			/^\.git$/i.test(part)
		) {
			throw new Error("Graph path must be a portable, repository-relative file path");
		}
		spelling = spelling ? `${spelling}/${part}` : part;
		prefixes.push([spelling.normalize("NFC").toUpperCase(), spelling]);
	}
	return prefixes;
}
