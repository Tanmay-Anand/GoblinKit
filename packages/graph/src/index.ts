/**
 * @goblin/graph — pure graph algorithms over a workflow document.
 *
 * No I/O, no runtime state: compiling a document and asking structural
 * questions about it must be possible in the editor, in a linter and in a test
 * with nothing else loaded.
 */
export * from './compile.js';
