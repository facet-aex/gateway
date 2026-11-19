export const USERNAME_PATTERN = "^[a-z0-9](?:[a-z0-9-]{6,14}[a-z0-9])$";
export const USERNAME_REGEX = new RegExp(USERNAME_PATTERN, "u");

export const FACET_NAME_PATTERN = "^[a-z0-9](?:[a-z0-9-]{2,30}[a-z0-9])$";
export const FACET_NAME_REGEX = new RegExp(FACET_NAME_PATTERN, "u");

export const SEMVER_PATTERN =
  "^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$";
export const SEMVER_REGEX = new RegExp(SEMVER_PATTERN, "u");

export const FACET_TYPES = ["API", "ACTOR", "AGENT"] as const;
export type FacetType = (typeof FACET_TYPES)[number];

export function isValidUsername(value: string): boolean {
  return USERNAME_REGEX.test(value);
}

export function isValidFacetName(value: string): boolean {
  return FACET_NAME_REGEX.test(value);
}

export function isValidSemver(value: string): boolean {
  return SEMVER_REGEX.test(value);
}
