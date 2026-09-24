// Pure, I/O-free domain logic shared by apps/web (API) and tests.
// Each module is owned by one task: monetization (A4), distribution (A5), rights (A6).
export * from "./monetization";
export * from "./distribution";
export * from "./rights";
export * from "./calendar";
