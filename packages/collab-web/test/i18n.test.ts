import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DEFAULT_LOCALE, getLocale, type Locale, setLocale, translate } from "../src/lib/i18n";

describe("i18n", () => {
	// The locale is module-global; restore it so other files in the same run keep theirs.
	let saved: Locale;
	beforeEach(() => {
		saved = getLocale();
	});
	afterEach(() => setLocale(saved));

	it("defaults to Turkish when nothing is stored", () => {
		expect(DEFAULT_LOCALE).toBe("tr");
	});

	it("fills {name} placeholders and leaves unknown ones visible", () => {
		expect(translate("en", "transcript.showEarlier", { count: 150 })).toBe("show 150 earlier");
		expect(translate("tr", "transcript.showEarlier", { count: 150 })).toBe("150 öncekini göster");
		expect(translate("en", "transcript.showEarlier", {})).toBe("show {count} earlier");
	});

	it("switches the active locale", () => {
		setLocale("en");
		expect(getLocale()).toBe("en");
		setLocale("tr");
		expect(getLocale()).toBe("tr");
	});
});
