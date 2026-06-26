/**
 * Public surface of the Savistor core. The core is a pure, DOM-free library:
 * give it bytes, it tells you what they are and lets you peel/edit/rebuild them.
 * The UI (and any future CLI) is just a consumer of this module.
 */

export * from "./bytes";
export * from "./detect";
export * from "./codecs";
export * from "./pipeline";
export * from "./checksums";
export * from "./profiles";
