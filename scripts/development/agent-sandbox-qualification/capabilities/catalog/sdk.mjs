// This module is copied into the selected consumer so ESM export conditions resolve there.
export const resolvePublicSdk = (specifier) => import.meta.resolve(specifier);
