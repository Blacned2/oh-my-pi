const systemVariables = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]);

/** Keep the Windows process essentials and leave provider and Docker settings with the host. */
export function systemProcessEnv(): Record<string, string | undefined> {
	return Object.fromEntries(Object.entries(Bun.env).filter(([key]) => systemVariables.has(key.toUpperCase())));
}
