import { defineI18n } from "fumadocs-core/i18n";

/**
 * English at the root (/docs/...), Spanish under /es. Only Get started and the FAQ are
 * translated; every other page falls back to English.
 */
export const i18n = defineI18n({
  defaultLanguage: "en",
  languages: ["en", "es"],
  hideLocale: "default-locale",
  parser: "dot",
});
