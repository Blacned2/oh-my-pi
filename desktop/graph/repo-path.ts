const invalidWindowsPath = /[<>:"\\|?*\x00-\x1f]/;
const deviceName = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/i;
/** An 8.3 short name such as `BACKEN~1.TXT` can open a different long-named file on Windows. */
const shortNameAlias = /^[^.~]{1,6}~[1-9][0-9]{0,5}(?:\.[^.]{1,3})?$/;

/** Validate a path a Graph task may write and return its Windows identity key and spelling. */
export function writablePathKey(file: string): [key: string, spelling: string] {
	const prefixes = repoPathPrefixes(file);
	if (file.split("/").some(part => shortNameAlias.test(part))) {
		throw new Error(`Graph path ${file} looks like a Windows short-name alias`);
	}
	return prefixes.at(-1)!;
}

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
