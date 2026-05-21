// Validators + thin wrappers around @clack/prompts. Each validator returns
// undefined on success or a string error message on failure — matches the
// @clack/prompts validate() contract.

const CODE_RE = /^[a-z][a-z0-9_-]*$/;
const ENTITY_RE = /^[a-z][a-z0-9_]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

export function validateCode(v: string): string | undefined {
	if (!v) return "Module code is required.";
	if (!CODE_RE.test(v)) {
		return "Must match ^[a-z][a-z0-9_-]*$ (lowercase, digits, underscore, hyphen; first char a letter).";
	}
}

export function validateEntityName(v: string): string | undefined {
	if (!v) return "Entity name is required.";
	if (!ENTITY_RE.test(v)) {
		return "Must match ^[a-z][a-z0-9_]*$ (lowercase, digits, underscore; first char a letter).";
	}
}

export function validateNonEmpty(v: string): string | undefined {
	if (!v || !v.trim()) return "Required.";
}

export function validateSemver(v: string): string | undefined {
	if (!v) return "Required.";
	if (!SEMVER_RE.test(v)) {
		return "Must be semver, e.g. 0.1.0 or 1.0.0-rc.1.";
	}
}

/**
 * Titlecase a module code by splitting on hyphen/underscore and
 * capitalising each part. Used to suggest a default `displayName`.
 *   "hr-admin" → "Hr Admin"
 *   "crm"      → "Crm"
 */
export function titlecase(code: string): string {
	return code
		.split(/[-_]/)
		.filter(Boolean)
		.map((s) => s.charAt(0).toUpperCase() + s.slice(1))
		.join(" ");
}
